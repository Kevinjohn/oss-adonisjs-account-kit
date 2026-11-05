/* eslint-disable @unicorn/no-await-expression-member -- Keep original responses beside their state and destination assertions. */
import { createHash, randomBytes } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { test } from '@japa/runner'
import type { Assert } from '@japa/assert'
import { Session } from '@adonisjs/session'
import db from '@adonisjs/lucid/services/db'
import limiter from '@adonisjs/limiter/services/main'
import { DateTime } from 'luxon'
import User from '#models/user'
import { setupAccountDatabase } from '#tests/helpers/account_database'

const origin = process.env.APP_URL!
const password = 'CorrectedPassword123!'
const families = ['reset-password', 'verify-email', 'confirm-email'] as const
type Family = (typeof families)[number]
const csrfMessage = 'Invalid or expired CSRF token'

/** Real native form session with manual redirects and the server-rendered hidden CSRF token. */
class ProofSession {
  private cookies = new Map<string, string>()
  private csrf?: string

  async request(
    path: string,
    options: {
      form?: Record<string, string>
      malformed?: boolean
      csrf?: boolean
      referer?: string
    } = {}
  ) {
    const post = options.form !== undefined || options.malformed
    const headers = new Headers({
      accept: 'text/html',
      cookie: [...this.cookies].map(([key, value]) => `${key}=${value}`).join('; '),
    })
    if (post)
      headers.set(
        'content-type',
        options.malformed ? 'application/json' : 'application/x-www-form-urlencoded'
      )
    if (options.referer) headers.set('referer', options.referer)
    const response = await fetch(new URL(path, origin), {
      method: post ? 'POST' : 'GET',
      headers,
      body: options.malformed
        ? '{"broken":'
        : options.form
          ? new URLSearchParams({
              ...options.form,
              ...(options.csrf === false ? {} : { _csrf: this.csrf ?? '' }),
            })
          : undefined,
      redirect: 'manual',
    })
    for (const cookie of response.headers.getSetCookie()) {
      const [name, value] = cookie.split(';')[0].split('=', 2)
      this.cookies.set(name, value ?? '')
    }
    if (response.headers.get('content-type')?.includes('text/html')) {
      const html = await response.clone().text()
      const input = html.match(/<input\b[^>]*\bname=(["'])_csrf\1[^>]*>/)?.[0]
      const token = input?.match(/\bvalue=(["'])([^"']+)\1/)?.[2]
      if (token) this.csrf = token
    }
    if (process.env.PROOF_HEADER_EVIDENCE)
      appendFileSync(
        process.env.PROOF_HEADER_EVIDENCE,
        JSON.stringify({
          method: post ? 'POST' : 'GET',
          path,
          status: response.status,
          headers: Object.fromEntries(
            ['cache-control', 'referrer-policy', 'location', 'content-type'].map((name) => [
              name,
              response.headers.get(name),
            ])
          ),
        }) + '\n'
      )
    return response
  }

  async prime() {
    await this.request('/login')
    if (!this.csrf) throw new Error('The native login form did not render a CSRF token')
  }
}

async function proofFor(family: Family, expired = false) {
  const token = randomBytes(40).toString('base64url')
  const email = `${family}@example.test`
  const user = await User.create({
    fullName: 'Proof Owner',
    email,
    password: 'OldPass123!',
    unverifiedEmail:
      family === 'verify-email'
        ? email
        : family === 'confirm-email'
          ? 'changed@example.test'
          : null,
  })
  const hash = createHash('sha256').update(token).digest('hex')
  const table = family === 'reset-password' ? 'password_reset_tokens' : 'email_verification_tokens'
  const now = new Date()
  await db.table(table).insert({
    tokenable_id: user.id,
    email: family === 'confirm-email' ? 'changed@example.test' : email,
    ...(family === 'reset-password'
      ? {}
      : {
          current_email: email,
          purpose: family === 'confirm-email' ? 'email_change' : 'activation',
        }),
    hash,
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + (expired ? -1000 : 3600000)).toISOString(),
  })
  return { user, token, hash, table, path: `/${family}/${token}` }
}

function protectedResponse(assert: Assert, response: Response) {
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer')
}

async function destination(
  assert: Assert,
  session: ProofSession,
  response: Response,
  expected: string
) {
  assert.equal(response.status, 302)
  const location = new URL(response.headers.get('location')!, origin)
  assert.equal(location.origin, origin)
  assert.equal(location.pathname, expected)
  assert.equal(location.search, '')
  const followed = await session.request(expected)
  assert.equal(followed.status, 200)
  if (/^\/(reset-password|verify-email|confirm-email)\//.test(expected))
    protectedResponse(assert, followed)
  return followed
}

async function completed(
  assert: Assert,
  family: Family,
  proof: Awaited<ReturnType<typeof proofFor>>
) {
  assert.notExists(await db.from(proof.table).where('hash', proof.hash).first())
  if (family === 'confirm-email')
    assert.equal((await User.findOrFail(proof.user.id)).email, 'changed@example.test')
  else assert.equal((await User.verifyCredentials(proof.user.email, password)).id, proof.user.id)
}

/** Observe the data real session middleware commits; restore even when a request fails. */
async function capturedFlashes<T>(operation: () => Promise<T>) {
  const committing = Session.prototype as unknown as { commit: (this: Session) => Promise<void> }
  const previous = committing.commit
  const flashes: string[] = []
  committing.commit = async function () {
    const feedback = JSON.stringify(this.responseFlashMessages.all())
    await previous.call(this)
    flashes.push(feedback)
  }
  try {
    return { result: await operation(), flashes }
  } finally {
    committing.commit = previous
  }
}

function safeCapturedFeedback(
  assert: Assert,
  flashes: string[],
  expected: string,
  secrets: string[]
) {
  assert.isNotEmpty(flashes)
  const persisted = flashes.join()
  assert.include(persisted, expected)
  assert.notInclude(persisted, '"input"')
  for (const secret of secrets) assert.notInclude(persisted, secret)
}

const form = { password, passwordConfirmation: password }

test.group('standalone native proof response boundary', (group) => {
  group.each.setup(async () => {
    const cleanup = await setupAccountDatabase()
    await limiter.clear(['memory'])
    return cleanup
  })

  for (const family of families) {
    const fallback = family === 'reset-password' ? '/forgot-password' : '/login'

    test(`${family}: valid GET, successful POST and consumed recovery`, async ({ assert }) => {
      const proof = await proofFor(family)
      const session = new ProofSession()
      await session.prime()
      const read = await session.request(proof.path)
      protectedResponse(assert, read)
      assert.equal(read.status, 200)
      assert.include(await read.text(), `action="/${family}/${proof.token}"`)
      assert.exists(await db.from(proof.table).where('hash', proof.hash).first())
      const done = await session.request(`${proof.path}?token=${proof.token}`, { form })
      protectedResponse(assert, done)
      const signedOut = await destination(assert, session, done, '/login')
      const body = await signedOut.text()
      assert.notInclude(body, proof.token)
      assert.notInclude(body, password)
      await completed(assert, family, proof)
      const consumed = await session.request(proof.path)
      protectedResponse(assert, consumed)
      assert.equal(consumed.status, 200)
      assert.include(await consumed.text(), 'This link is invalid, already used, or expired')
      const replay = await session.request(proof.path, { form })
      protectedResponse(assert, replay)
      const recovered = await destination(assert, session, replay, fallback)
      assert.match(await recovered.text(), /This (reset|verification|email) link is invalid/)
    })

    for (const expired of [false, true]) {
      test(`${family}: ${expired ? 'expired' : 'malformed'} GET and POST`, async ({ assert }) => {
        const proof = await proofFor(family, expired)
        const path = expired ? proof.path : `/${family}/not-a-proof`
        const session = new ProofSession()
        await session.prime()
        const read = await session.request(path)
        protectedResponse(assert, read)
        assert.equal(read.status, 200)
        assert.include(await read.text(), 'This link is invalid, already used, or expired')
        const failed = await session.request(`${path}?token=${proof.token}`, {
          form,
          referer: 'https://untrusted.example/steal',
        })
        protectedResponse(assert, failed)
        const recovered = await destination(assert, session, failed, fallback)
        const feedback = await recovered.text()
        assert.match(feedback, /This (reset|verification|email) link is invalid/)
        assert.notInclude(feedback, proof.token)
        assert.exists(await db.from(proof.table).where('hash', proof.hash).first())
      })
    }

    for (const variant of ['encoded', 'trailing-slash', 'encoded-separator'] as const) {
      test(`${family}: ${variant} canonical recovery`, async ({ assert }) => {
        const proof = await proofFor(family)
        const session = new ProofSession()
        await session.prime()
        const encoded = `%${proof.token.charCodeAt(0).toString(16)}${proof.token.slice(1)}`
        const path =
          variant === 'encoded'
            ? `/${family}/${encoded}`
            : variant === 'trailing-slash'
              ? `${proof.path}/`
              : `/${family}/${proof.token}%2Fextra`
        const rejected = await session.request(`${path}?token=${proof.token}`, {
          form,
          csrf: false,
          referer: 'https://untrusted.example/steal',
        })
        protectedResponse(assert, rejected)
        const recovered = await destination(
          assert,
          session,
          rejected,
          variant === 'encoded-separator' ? fallback : proof.path
        )
        const feedback = await recovered.text()
        assert.include(feedback, csrfMessage)
        assert.notInclude(feedback, password)
        assert.exists(await db.from(proof.table).where('hash', proof.hash).first())
      })
    }

    test(`${family}: invalid proof CSRF uses fixed recovery`, async ({ assert }) => {
      const session = new ProofSession()
      await session.prime()
      const rejected = await session.request(`/${family}/not-a-proof`, {
        form,
        csrf: false,
        referer: 'https://untrusted.example/steal',
      })
      protectedResponse(assert, rejected)
      const recovered = await destination(assert, session, rejected, fallback)
      const feedback = await recovered.text()
      assert.include(feedback, csrfMessage)
      assert.notInclude(feedback, password)
    })

    test(`${family}: genuine malformed body precedes CSRF`, async ({ assert }) => {
      const proof = await proofFor(family)
      const session = new ProofSession()
      await session.prime()
      const rejected = await session.request(proof.path, { malformed: true, csrf: false })
      assert.equal(rejected.status, 400)
      protectedResponse(assert, rejected)
      assert.isNull(rejected.headers.get('location'))
      const retried = await session.request(proof.path)
      assert.equal(retried.status, 200)
      protectedResponse(assert, retried)
      assert.exists(await db.from(proof.table).where('hash', proof.hash).first())
    })

    for (const referer of [undefined, 'https://untrusted.example/steal']) {
      test(`${family}: genuine CSRF correction with ${referer ? 'hostile' : 'absent'} Referer`, async ({
        assert,
      }) => {
        const proof = await proofFor(family)
        const session = new ProofSession()
        await session.prime()
        const rejected = await session.request(`${proof.path}?token=${proof.token}`, {
          form,
          csrf: false,
          referer,
        })
        protectedResponse(assert, rejected)
        const recovered = await destination(assert, session, rejected, proof.path)
        const feedback = await recovered.text()
        assert.include(feedback, csrfMessage)
        assert.notInclude(feedback, password)
        assert.exists(await db.from(proof.table).where('hash', proof.hash).first())
        const corrected = await session.request(proof.path, { form })
        protectedResponse(assert, corrected)
        await destination(assert, session, corrected, '/login')
        await completed(assert, family, proof)
      })
    }

    if (family !== 'confirm-email') {
      for (const state of ['malformed', 'expired', 'consumed'] as const) {
        test(`${family} HTML: ${state} proof validation has visible renewal feedback`, async ({
          assert,
        }) => {
          const proof = await proofFor(family, state === 'expired')
          if (state === 'consumed') await db.from(proof.table).where('hash', proof.hash).delete()
          const path = state === 'malformed' ? `/${family}/not-a-proof` : proof.path
          const before = await db.from('users').where('id', proof.user.id).first()
          const session = new ProofSession()
          await session.prime()
          const observed = await capturedFlashes(() =>
            session.request(`${path}?token=${proof.token}`, {
              form: { password, passwordConfirmation: 'MismatchedSecret123!' },
              referer: 'https://untrusted.example/steal',
            })
          )
          const rejected = observed.result
          assert.include(observed.flashes.join(), 'passwordConfirmation')
          protectedResponse(assert, rejected)
          safeCapturedFeedback(assert, observed.flashes, 'This link is invalid or has expired.', [
            proof.token,
            password,
            'MismatchedSecret123!',
          ])
          const recovered = await destination(assert, session, rejected, fallback)
          const feedback = await recovered.text()
          assert.include(feedback, 'This link is invalid or has expired.')
          for (const secret of [proof.token, password, 'MismatchedSecret123!'])
            assert.notInclude(feedback, secret)
          assert.deepEqual(await db.from('users').where('id', proof.user.id).first(), before)
          assert.equal(
            Boolean(await db.from(proof.table).where('hash', proof.hash).first()),
            state !== 'consumed'
          )
        })
      }

      for (const referer of [undefined, 'https://untrusted.example/steal']) {
        test(`${family}: validation and correction with ${referer ? 'hostile' : 'absent'} Referer`, async ({
          assert,
        }) => {
          const proof = await proofFor(family)
          const session = new ProofSession()
          await session.prime()
          const rejected = await session.request(`${proof.path}?token=${proof.token}`, {
            form: { password, passwordConfirmation: 'MismatchedSecret123!' },
            referer,
          })
          protectedResponse(assert, rejected)
          const recovered = await destination(assert, session, rejected, proof.path)
          const feedback = await recovered.text()
          assert.include(feedback, 'Confirm password must match Password.')
          assert.notInclude(feedback, 'This link is invalid or has expired.')
          assert.notInclude(feedback, password)
          assert.notInclude(feedback, 'MismatchedSecret123!')
          assert.exists(await db.from(proof.table).where('hash', proof.hash).first())
          const corrected = await session.request(proof.path, { form })
          protectedResponse(assert, corrected)
          await destination(assert, session, corrected, '/login')
          await completed(assert, family, proof)
        })
      }
    }

    for (const method of ['GET', 'PUT', 'PATCH']) {
      for (const referer of [
        undefined,
        'https://untrusted.example/steal',
        `${origin}/login?token=private-referer-query`,
      ]) {
        test(`${family}: body _method=${method} without CSRF keeps canonical recovery with ${referer === undefined ? 'absent' : referer.startsWith(origin) ? 'same-origin query' : 'hostile'} Referer`, async ({
          assert,
        }) => {
          const proof = await proofFor(family)
          const session = new ProofSession()
          await session.prime()
          const beforeProof = await db.from(proof.table).where('hash', proof.hash).first()
          const beforeUser = await db.from('users').where('id', proof.user.id).first()
          const input = {
            ...form,
            _method: method,
            email: proof.token,
            fullName: 'PrivateOverrideName',
            currentPassword: 'PrivateOverrideCurrentPassword',
            token: proof.token,
          }
          const observed = await capturedFlashes(() =>
            session.request(`${proof.path}?token=${proof.token}`, {
              form: input,
              csrf: false,
              referer,
            })
          )
          protectedResponse(assert, observed.result)
          const recovered = await destination(assert, session, observed.result, proof.path)
          assert.include(await recovered.text(), csrfMessage)
          safeCapturedFeedback(assert, observed.flashes, csrfMessage, [
            proof.token,
            password,
            'PrivateOverrideName',
            'PrivateOverrideCurrentPassword',
            'private-referer-query',
          ])
          assert.include(observed.flashes.join(), 'E_BAD_CSRF_TOKEN')
          assert.deepEqual(
            await db.from(proof.table).where('hash', proof.hash).first(),
            beforeProof
          )
          assert.deepEqual(await db.from('users').where('id', proof.user.id).first(), beforeUser)
          const corrected = await session.request(proof.path, { form })
          protectedResponse(assert, corrected)
          await destination(assert, session, corrected, '/login')
          await completed(assert, family, proof)
        })
      }
    }

    for (const method of ['PUT', 'PATCH']) {
      test(`${family}: body _method=${method} keeps expired proof recovery fixed and private`, async ({
        assert,
      }) => {
        const proof = await proofFor(family, true)
        const session = new ProofSession()
        await session.prime()
        const beforeProof = await db.from(proof.table).where('hash', proof.hash).first()
        const beforeUser = await db.from('users').where('id', proof.user.id).first()
        const input = {
          ...form,
          _method: method,
          email: proof.token,
          fullName: 'PrivateOverrideName',
          currentPassword: 'PrivateOverrideCurrentPassword',
        }
        const secrets = [
          proof.token,
          password,
          'PrivateOverrideName',
          'PrivateOverrideCurrentPassword',
          'private-referer-query',
        ]
        const referer = `${origin}/login?token=private-referer-query`
        const csrf = await capturedFlashes(() =>
          session.request(`${proof.path}?token=${proof.token}`, {
            form: input,
            csrf: false,
            referer,
          })
        )
        protectedResponse(assert, csrf.result)
        safeCapturedFeedback(assert, csrf.flashes, csrfMessage, secrets)
        assert.include(csrf.flashes.join(), 'E_BAD_CSRF_TOKEN')
        const rejected = await destination(assert, session, csrf.result, fallback)
        assert.include(await rejected.text(), csrfMessage)
        const invalid = await capturedFlashes(() =>
          session.request(`${proof.path}?token=${proof.token}`, { form: input, referer })
        )
        protectedResponse(assert, invalid.result)
        const invalidMessage =
          family === 'reset-password'
            ? 'This reset link is invalid'
            : family === 'verify-email'
              ? 'This verification link is invalid'
              : 'This email link is invalid'
        safeCapturedFeedback(assert, invalid.flashes, invalidMessage, secrets)
        const recovered = await destination(assert, session, invalid.result, fallback)
        const feedback = await recovered.text()
        assert.include(feedback, invalidMessage)
        for (const secret of secrets) assert.notInclude(feedback, secret)
        assert.deepEqual(await db.from(proof.table).where('hash', proof.hash).first(), beforeProof)
        assert.deepEqual(await db.from('users').where('id', proof.user.id).first(), beforeUser)
      })
    }

    if (family !== 'confirm-email') {
      for (const method of ['PUT', 'PATCH']) {
        for (const referer of [
          undefined,
          'https://untrusted.example/steal',
          `${origin}/login?token=private-referer-query`,
        ]) {
          test(`${family}: body _method=${method} with valid CSRF retains validation and correction with ${referer === undefined ? 'absent' : referer.startsWith(origin) ? 'same-origin query' : 'hostile'} Referer`, async ({
            assert,
          }) => {
            const proof = await proofFor(family)
            const session = new ProofSession()
            await session.prime()
            const beforeProof = await db.from(proof.table).where('hash', proof.hash).first()
            const beforeUser = await db.from('users').where('id', proof.user.id).first()
            const observed = await capturedFlashes(() =>
              session.request(`${proof.path}?token=${proof.token}`, {
                form: {
                  ...form,
                  passwordConfirmation: 'MismatchedSecret123!',
                  _method: method,
                  email: proof.token,
                  fullName: 'PrivateOverrideName',
                  currentPassword: 'PrivateOverrideCurrentPassword',
                },
                referer,
              })
            )
            protectedResponse(assert, observed.result)
            const recovered = await destination(assert, session, observed.result, proof.path)
            assert.include(await recovered.text(), 'Confirm password must match Password.')
            safeCapturedFeedback(
              assert,
              observed.flashes,
              'Confirm password must match Password.',
              [
                proof.token,
                password,
                'MismatchedSecret123!',
                'PrivateOverrideName',
                'PrivateOverrideCurrentPassword',
                'private-referer-query',
              ]
            )
            assert.include(observed.flashes.join(), 'passwordConfirmation')
            assert.deepEqual(
              await db.from(proof.table).where('hash', proof.hash).first(),
              beforeProof
            )
            assert.deepEqual(await db.from('users').where('id', proof.user.id).first(), beforeUser)
            const corrected = await session.request(proof.path, { form })
            protectedResponse(assert, corrected)
            await destination(assert, session, corrected, '/login')
            await completed(assert, family, proof)
          })
        }
      }
    }

    test(`${family}: native correction, identity and referrer protection without JavaScript`, async ({
      browser,
      assert,
    }) => {
      const proof = await proofFor(family)
      const other = await User.create({
        fullName: 'Other Visitor',
        email: 'other@example.test',
        password: 'OldPass123!',
        emailVerifiedAt: DateTime.now(),
        unverifiedEmail: null,
      })
      const context = await browser.newContext({ baseURL: origin, javaScriptEnabled: false })
      try {
        const page = await context.visit('/login')
        await page.getByLabel('Email').fill(other.email)
        await page.getByLabel('Password').fill('OldPass123!')
        await page.getByRole('button', { name: 'Sign in' }).click()
        await page.getByText('Signed in as other@example.test.').waitFor()
        const document = await page.goto(proof.path)
        assert.equal(document!.headers()['cache-control'], 'no-store')
        assert.equal(document!.headers()['referrer-policy'], 'no-referrer')
        const followOn = page.waitForRequest((request) => new URL(request.url()).pathname === '/')
        await page.getByRole('link', { name: 'AdonisJS', exact: true }).click()
        const referrer = (await followOn).headers()['referer']
        assert.equal(referrer ?? '', '')
        await page.getByRole('link', { name: 'Dashboard', exact: true }).click()
        await page.getByText('Signed in as other@example.test.').waitFor()
        await page.goto(proof.path)
        const rejected = await page.request.post(`${origin}${proof.path}?token=${proof.token}`, {
          form,
          maxRedirects: 0,
        })
        assert.equal(rejected.status(), 302)
        assert.equal(rejected.headers()['cache-control'], 'no-store')
        assert.equal(rejected.headers()['referrer-policy'], 'no-referrer')
        assert.equal(new URL(rejected.headers()['location'], origin).pathname, proof.path)
        assert.equal(new URL(rejected.headers()['location'], origin).search, '')
        await page.goto(proof.path)
        await page.getByText(csrfMessage, { exact: true }).first().waitFor()
        if (family !== 'confirm-email') {
          const label = family === 'reset-password' ? 'New password' : 'Choose a password'
          const button = family === 'reset-password' ? 'Reset password' : 'Confirm email'
          await page.getByLabel(label, { exact: true }).fill(password)
          await page.getByLabel('Confirm password').fill('MismatchedSecret123!')
          const invalidResponse = page.waitForResponse(
            (candidate) =>
              candidate.request().method() === 'POST' &&
              new URL(candidate.url()).pathname === proof.path
          )
          await page.getByRole('button', { name: button, exact: true }).click()
          const invalid = await invalidResponse
          assert.equal(invalid.status(), 302)
          assert.equal(invalid.headers()['cache-control'], 'no-store')
          assert.equal(invalid.headers()['referrer-policy'], 'no-referrer')
          await page.getByText('Confirm password must match Password.', { exact: true }).waitFor()
          assert.equal(new URL(page.url()).pathname, proof.path)
          assert.equal(await page.getByLabel(label, { exact: true }).inputValue(), '')
          assert.equal(await page.getByLabel('Confirm password').inputValue(), '')
          await page.getByLabel(label, { exact: true }).fill(password)
          await page.getByLabel('Confirm password').fill(password)
          await page.getByRole('button', { name: button, exact: true }).click()
        } else await page.getByRole('button', { name: 'Confirm email change', exact: true }).click()
        await page.getByText('Welcome to the power of a Hypermedia app.').waitFor()
        await page.goto('/dashboard')
        await page.getByText('Signed in as other@example.test.').waitFor()
        await completed(assert, family, proof)
        assert.equal((await User.verifyCredentials(other.email, 'OldPass123!')).id, other.id)
        if (process.env.PROOF_HEADER_EVIDENCE)
          appendFileSync(
            process.env.PROOF_HEADER_EVIDENCE,
            JSON.stringify({
              browser: true,
              family,
              javaScriptEnabled: false,
              referrer: referrer ?? null,
              retainedVisitorId: other.id,
              proofOwnerId: proof.user.id,
            }) + '\n'
          )
      } finally {
        await context.close()
      }
    })
  }

  test('proof correction never commits bearer tokens or submitted secrets as flash input', async ({
    assert,
  }) => {
    for (const family of families) {
      const proof = await proofFor(family)
      const session = new ProofSession()
      await session.prime()
      const input = { ...form, email: proof.token, fullName: proof.token }
      const csrf = await capturedFlashes(() =>
        session.request(proof.path, { form: input, csrf: false })
      )
      protectedResponse(assert, csrf.result)
      safeCapturedFeedback(assert, csrf.flashes, csrfMessage, [proof.token, password])
      assert.include(csrf.flashes.join(), 'E_BAD_CSRF_TOKEN')
      const recovered = await destination(assert, session, csrf.result, proof.path)
      assert.include(await recovered.text(), csrfMessage)
      if (family !== 'confirm-email') {
        const invalid = await capturedFlashes(() =>
          session.request(proof.path, {
            form: { ...input, passwordConfirmation: 'MismatchedSecret123!' },
          })
        )
        protectedResponse(assert, invalid.result)
        safeCapturedFeedback(assert, invalid.flashes, 'Confirm password must match Password.', [
          proof.token,
          password,
          'MismatchedSecret123!',
        ])
        assert.include(invalid.flashes.join(), 'passwordConfirmation')
        const feedback = await destination(assert, session, invalid.result, proof.path)
        assert.include(await feedback.text(), 'Confirm password must match Password.')
      }
    }
  })
  for (const recoveryFamily of ['reset-password', 'verify-email'] as const) {
    test(`${recoveryFamily}: expired validation renders renewal feedback without JavaScript`, async ({
      browser,
      assert,
    }) => {
      const proof = await proofFor(recoveryFamily)
      const context = await browser.newContext({ baseURL: origin, javaScriptEnabled: false })
      try {
        const page = await context.visit(proof.path)
        await db
          .from(proof.table)
          .where('hash', proof.hash)
          .update({ expires_at: new Date(Date.now() - 1000).toISOString() })
        await page
          .getByLabel(recoveryFamily === 'reset-password' ? 'New password' : 'Choose a password', {
            exact: true,
          })
          .fill(password)
        await page.getByLabel('Confirm password').fill('MismatchedSecret123!')
        await page
          .getByRole('button', {
            name: recoveryFamily === 'reset-password' ? 'Reset password' : 'Confirm email',
            exact: true,
          })
          .click()
        await page.waitForURL(
          recoveryFamily === 'reset-password' ? '**/forgot-password' : '**/login'
        )
        await page
          .getByText('This link is invalid or has expired.', { exact: true })
          .waitFor({ state: 'visible' })
        assert.equal(new URL(page.url()).search, '')
        assert.equal(
          (await User.verifyCredentials(proof.user.email, 'OldPass123!')).id,
          proof.user.id
        )
        assert.exists(await db.from(proof.table).where('hash', proof.hash).first())
      } finally {
        await context.close()
      }
    })
  }
})
