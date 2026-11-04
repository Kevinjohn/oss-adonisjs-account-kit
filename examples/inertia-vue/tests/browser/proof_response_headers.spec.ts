/* eslint-disable @unicorn/no-await-expression-member -- Keep raw response assertions beside their requests. */
import { createHash, randomBytes } from 'node:crypto'
import { test } from '@japa/runner'
import type { Assert } from '@japa/assert'
import db from '@adonisjs/lucid/services/db'
import User from '#models/user'
import { setupAccountDatabase } from '../helpers/account_database.js'

const origin = process.env.APP_URL!
const password = 'CorrectedPassword123!'
const families = ['reset-password', 'verify-email', 'confirm-email'] as const
type Family = (typeof families)[number]

/** Real HTTP session: manual redirects expose the original token-bearing response. */
class ProofSession {
  private cookies = new Map<string, string>()
  private version?: string

  constructor(private inertia: boolean) {}

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
    if (this.inertia) {
      headers.set('x-inertia', 'true')
      if (this.version) headers.set('x-inertia-version', this.version)
    }
    if (post) {
      headers.set(
        'content-type',
        options.malformed ? 'application/json' : 'application/x-www-form-urlencoded'
      )
      if (options.csrf !== false) {
        headers.set('x-xsrf-token', decodeURIComponent(this.cookies.get('XSRF-TOKEN') ?? ''))
      }
    }
    if (options.referer) headers.set('referer', options.referer)
    const response = await fetch(new URL(path, origin), {
      method: post ? 'POST' : 'GET',
      headers,
      body: options.malformed
        ? '{"broken":'
        : options.form
          ? new URLSearchParams(options.form)
          : undefined,
      redirect: 'manual',
    })
    for (const cookie of response.headers.getSetCookie()) {
      const [name, value] = cookie.split(';')[0].split('=', 2)
      this.cookies.set(name, value ?? '')
    }
    return response
  }

  async prime() {
    const response = await this.request('/')
    if (this.inertia) this.version = ((await response.json()) as { version: string }).version
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
  assert.include([302, 303], response.status)
  const location = response.headers.get('location')!
  assert.equal(new URL(location, origin).origin, origin)
  assert.equal(new URL(location, origin).pathname, expected)
  assert.equal(new URL(location, origin).search, '')
  const followed = await session.request(expected)
  assert.equal(followed.status, 200)
  if (/^\/(reset-password|verify-email|confirm-email)\//.test(expected))
    protectedResponse(assert, followed)
  return followed
}

const form = { password, passwordConfirmation: password }

test.group('standalone Vue proof response boundary', (group) => {
  group.each.setup(setupAccountDatabase)

  for (const family of families) {
    for (const inertia of [false, true]) {
      const representation = inertia ? 'Inertia' : 'HTML'
      const fallback = family === 'reset-password' ? '/forgot-password' : '/login'

      test(`${family} ${representation}: valid GET, successful POST and consumed recovery`, async ({
        assert,
      }) => {
        const proof = await proofFor(family)
        const session = new ProofSession(inertia)
        await session.prime()
        const read = await session.request(proof.path)
        assert.equal(read.status, 200)
        protectedResponse(assert, read)
        assert.exists(await db.from(proof.table).where('hash', proof.hash).first())
        if (inertia)
          assert.equal(((await read.json()) as { props: { valid: boolean } }).props.valid, true)
        else assert.include(await read.text(), '"valid":true')
        const complete = await session.request(`${proof.path}?token=${proof.token}`, { form })
        protectedResponse(assert, complete)
        const signedOut = await destination(assert, session, complete, '/login')
        const signedOutBody = await signedOut.text()
        assert.notInclude(signedOutBody, proof.token)
        assert.notInclude(signedOutBody, password)
        assert.notExists(await db.from(proof.table).where('hash', proof.hash).first())
        if (family === 'confirm-email')
          assert.equal((await User.findOrFail(proof.user.id)).email, 'changed@example.test')
        else
          assert.equal((await User.verifyCredentials(proof.user.email, password)).id, proof.user.id)
        const consumed = await session.request(proof.path)
        assert.equal(consumed.status, 200)
        protectedResponse(assert, consumed)
        if (inertia)
          assert.equal(
            ((await consumed.json()) as { props: { valid: boolean } }).props.valid,
            false
          )
        const replay = await session.request(proof.path, { form })
        protectedResponse(assert, replay)
        await destination(assert, session, replay, fallback)
      })

      for (const expired of [false, true]) {
        test(`${family} ${representation}: ${expired ? 'expired' : 'malformed'} GET and POST`, async ({
          assert,
        }) => {
          const proof = await proofFor(family, expired)
          const path = expired ? proof.path : `/${family}/not-a-proof`
          const session = new ProofSession(inertia)
          await session.prime()
          const read = await session.request(path)
          protectedResponse(assert, read)
          assert.equal(read.status, 200)
          if (inertia)
            assert.equal(((await read.json()) as { props: { valid: boolean } }).props.valid, false)
          else assert.include(await read.text(), '"valid":false')
          const failed = await session.request(`${path}?token=${proof.token}`, {
            form,
            referer: 'https://untrusted.example/steal',
          })
          protectedResponse(assert, failed)
          const followed = await destination(assert, session, failed, fallback)
          assert.notInclude(await followed.text(), proof.token)
          assert.exists(await db.from(proof.table).where('hash', proof.hash).first())
        })
      }

      test(`${family} ${representation}: invalid proof CSRF rejection uses fixed recovery`, async ({
        assert,
      }) => {
        const session = new ProofSession(inertia)
        await session.prime()
        const rejected = await session.request(`/${family}/not-a-proof`, {
          form,
          csrf: false,
          referer: 'https://untrusted.example/steal',
        })
        protectedResponse(assert, rejected)
        const recovered = await destination(assert, session, rejected, fallback)
        assert.notInclude(await recovered.text(), password)
      })

      test(`${family} ${representation}: genuine malformed body rejection precedes CSRF`, async ({
        assert,
      }) => {
        const proof = await proofFor(family)
        const session = new ProofSession(inertia)
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
        test(`${family} ${representation}: genuine CSRF recovery with ${referer ? 'hostile' : 'absent'} Referer`, async ({
          assert,
        }) => {
          const proof = await proofFor(family)
          const session = new ProofSession(inertia)
          await session.prime()
          const rejected = await session.request(`${proof.path}?token=${proof.token}`, {
            form,
            csrf: false,
            referer,
          })
          protectedResponse(assert, rejected)
          const recovered = await destination(assert, session, rejected, proof.path)
          const feedback = await recovered.text()
          assert.include(feedback, 'The form expired.')
          assert.notInclude(feedback, password)
          const corrected = await session.request(proof.path, { form })
          protectedResponse(assert, corrected)
          await destination(assert, session, corrected, '/login')
        })
      }

      if (family !== 'confirm-email') {
        for (const referer of [undefined, 'https://untrusted.example/steal']) {
          test(`${family} ${representation}: validation and correction with ${referer ? 'hostile' : 'absent'} Referer`, async ({
            assert,
          }) => {
            const proof = await proofFor(family)
            const session = new ProofSession(inertia)
            await session.prime()
            const rejected = await session.request(`${proof.path}?token=${proof.token}`, {
              form: { password, passwordConfirmation: 'MismatchedSecret123!' },
              referer,
            })
            protectedResponse(assert, rejected)
            const recovered = await destination(assert, session, rejected, proof.path)
            const feedback = await recovered.text()
            assert.include(feedback, 'passwordConfirmation')
            assert.notInclude(feedback, password)
            assert.notInclude(feedback, 'MismatchedSecret123!')
            assert.exists(await db.from(proof.table).where('hash', proof.hash).first())
            const corrected = await session.request(proof.path, { form })
            protectedResponse(assert, corrected)
            await destination(assert, session, corrected, '/login')
            assert.equal(
              (await User.verifyCredentials(proof.user.email, password)).id,
              proof.user.id
            )
          })
        }
      }
    }
  }

  for (const family of families) {
    test(`${family}: browser correction, identity and same-origin referrer protection`, async ({
      visit,
      assert,
    }) => {
      const proof = await proofFor(family)
      const other = await User.create({
        fullName: 'Other Browser User',
        email: 'other@example.test',
        password: 'OldPass123!',
      })
      const page = await visit('/login')
      await page.getByLabel('Email').fill(other.email)
      await page.getByLabel('Password').fill('OldPass123!')
      await page.getByRole('button', { name: 'Sign in' }).click()
      await page.waitForURL('**/dashboard')
      const response = await page.goto(new URL(proof.path, origin).href)
      assert.equal(response!.headers()['cache-control'], 'no-store')
      assert.equal(response!.headers()['referrer-policy'], 'no-referrer')
      const followOn = page.waitForRequest(
        (request) => new URL(request.url()).pathname === '/dashboard'
      )
      const current = await page.evaluate(async () => {
        const dashboard = await fetch('/dashboard', { headers: { 'x-inertia': 'true' } })
        return (await dashboard.json()) as { props: { user: { id: number } } }
      })
      assert.equal(current.props.user.id, other.id)
      assert.isUndefined((await followOn).headers()['referer'])
      assert.equal((await User.findOrFail(other.id)).email, other.email)
      if (family !== 'confirm-email') {
        const passwordLabel = family === 'reset-password' ? 'New password' : 'Password'
        const confirmationLabel =
          family === 'reset-password' ? 'Confirm new password' : 'Confirm password'
        const button = family === 'reset-password' ? 'Reset password' : 'Confirm email'
        await page.getByLabel(passwordLabel, { exact: true }).fill(password)
        await page.getByLabel(confirmationLabel).fill('MismatchedSecret123!')
        const invalidResponse = page.waitForResponse(
          (candidate) =>
            candidate.request().method() === 'POST' &&
            new URL(candidate.url()).pathname === proof.path
        )
        await page.getByRole('button', { name: button, exact: true }).click()
        const invalid = await invalidResponse
        assert.include([302, 303], invalid.status())
        assert.equal(invalid.headers()['referrer-policy'], 'no-referrer')
        assert.equal(invalid.headers()['cache-control'], 'no-store')
        await page.locator('#passwordConfirmation[aria-invalid="true"]').waitFor()
        assert.equal(new URL(page.url()).pathname, proof.path)
        assert.equal(await page.getByLabel(passwordLabel, { exact: true }).inputValue(), '')
        assert.equal(await page.getByLabel(confirmationLabel).inputValue(), '')
        await page.getByLabel(passwordLabel, { exact: true }).fill(password)
        await page.getByLabel(confirmationLabel).fill(password)
        await page.getByRole('button', { name: button, exact: true }).click()
      } else {
        await page.getByRole('button', { name: 'Confirm email change', exact: true }).click()
      }
      await page.waitForURL('**/login')
      await page.goto(new URL('/dashboard', origin).href)
      await page.waitForURL('**/login')
      assert.equal((await User.verifyCredentials(other.email, 'OldPass123!')).id, other.id)
    })
  }
})
