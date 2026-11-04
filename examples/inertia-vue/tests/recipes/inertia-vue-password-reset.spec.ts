/* eslint-disable @unicorn/no-await-expression-member, @unicorn/filename-case -- Keep browser assertions beside each native form action and match the recipe selector. */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { test } from '@japa/runner'
import type { Assert } from '@japa/assert'
import { MessageBuilder } from '@adonisjs/core/helpers'
import { errors as authErrors } from '@adonisjs/auth'
import db from '@adonisjs/lucid/services/db'
import testUtils from '@adonisjs/core/services/test_utils'
import User from '#models/user'
import { notifyOverrides } from '../../config/account_kit.js'

const originalPassword = 'OriginalPass123!'
const replacementPassword = 'ReplacementPass123!'
const recipeOrigin = process.env.APP_URL!

class RecipeProofSession {
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
      if (!options.malformed && options.csrf !== false) {
        headers.set('x-xsrf-token', decodeURIComponent(this.cookies.get('XSRF-TOKEN') ?? ''))
      }
    }
    if (options.referer) headers.set('referer', options.referer)
    const response = await fetch(new URL(path, recipeOrigin), {
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
    if (process.env.PROOF_HEADER_EVIDENCE) {
      appendFileSync(
        process.env.PROOF_HEADER_EVIDENCE,
        JSON.stringify({
          method: post ? 'POST' : 'GET',
          path,
          inertia: this.inertia,
          status: response.status,
          headers: Object.fromEntries(
            ['cache-control', 'referrer-policy', 'location', 'content-type'].map((name) => [
              name,
              response.headers.get(name),
            ])
          ),
        }) + '\n'
      )
    }
    return response
  }

  async prime() {
    const response = await this.request('/')
    if (this.inertia) this.version = ((await response.json()) as { version: string }).version
  }
}

function assertProofHeaders(
  assert: { equal(actual: unknown, expected: unknown): void },
  response: Response
) {
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer')
}

async function followProtected(
  assert: Parameters<typeof assertProofHeaders>[0],
  session: RecipeProofSession,
  response: Response,
  path: string
) {
  assert.equal([302, 303].includes(response.status), true)
  const location = response.headers.get('location')!
  assert.equal(new URL(location, recipeOrigin).origin, recipeOrigin)
  assert.equal(new URL(location, recipeOrigin).pathname, path)
  assert.equal(new URL(location, recipeOrigin).search, '')
  const followed = await session.request(path)
  assert.equal(followed.status, 200)
  if (path.startsWith('/reset-password/')) assertProofHeaders(assert, followed)
  return followed
}

const resetForm = { password: replacementPassword, passwordConfirmation: replacementPassword }

async function recipeProof(expired = false) {
  const email = `boundary-${randomUUID()}@example.test`
  const owner = await User.create({
    fullName: 'Recipe Proof Owner',
    email,
    password: originalPassword,
  })
  const token = randomBytes(40).toString('base64url')
  const hash = createHash('sha256').update(token).digest('hex')
  const now = new Date()
  await db.table('password_reset_tokens').insert({
    tokenable_id: owner.id,
    email,
    hash,
    created_at: new Date(now.getTime() - (expired ? 7200000 : 0)).toISOString(),
    expires_at: new Date(now.getTime() + (expired ? -3600000 : 3600000)).toISOString(),
  })
  return { owner, token, hash, path: `/reset-password/${token}`, originalHash: owner.password }
}

async function assertUnchanged(assert: Assert, proof: Awaited<ReturnType<typeof recipeProof>>) {
  await proof.owner.refresh()
  assert.equal(proof.owner.password, proof.originalHash)
  assert.equal(
    (await User.verifyCredentials(proof.owner.email, originalPassword)).id,
    proof.owner.id
  )
  assert.exists(await db.from('password_reset_tokens').where('hash', proof.hash).first())
}

/** Verify committed database sessions before following consumes their flash messages. */
async function assertStoredFlash(assert: Assert, feedback: string, secrets: string[]) {
  const rows = await db.from('sessions').select('id', 'data')
  assert.isAbove(rows.length, 0)
  const decoded = rows.map((row) => {
    const data = new MessageBuilder().verify(row.data, row.id)
    assert.isNotNull(data)
    return data as { __flash__?: Record<string, unknown> }
  })
  const flashes = decoded.map((data) => data.__flash__).filter(Boolean)
  assert.isAbove(flashes.length, 0)
  const stored = JSON.stringify(flashes)
  assert.include(stored, feedback)
  for (const secret of secrets) assert.notInclude(stored, secret)
  for (const flash of flashes) {
    for (const key of ['password', 'passwordConfirmation', 'email', 'token', 'extra']) {
      assert.notProperty(flash!, key)
    }
  }
}

test.group('Inertia Vue password reset recipe', (group) => {
  group.each.setup(async () => {
    const cleanup = await testUtils.db().truncate()
    await db
      .table('account_transaction_lock')
      .insert({ id: 1, version: 0 })
      .onConflict('id')
      .ignore()
    return cleanup
  })

  test('the original login and two browser sessions obey the complete reset lifecycle', async ({
    visit,
    browser,
    assert,
  }) => {
    const email = `recipe-${randomUUID()}@example.test`
    const owner = await User.create({ fullName: 'Recipe Owner', email, password: originalPassword })
    const originalHash = owner.password
    const notify = notifyOverrides
    const previousNotify = notify.passwordResetProvision
    const resetUrls: string[] = []
    notify.passwordResetProvision = async (_user, url) => {
      resetUrls.push(url)
    }

    const secondContext = await browser.newContext({ baseURL: process.env.APP_URL })
    const requesterContext = await browser.newContext({ baseURL: process.env.APP_URL })
    const submitProof = async (path: string) => {
      await requesterContext.initiateSession()
      await requesterContext.request.get(path)
      const csrfCookie = (await requesterContext.cookies()).find(
        (cookie) => cookie.name === 'XSRF-TOKEN'
      )
      assert.exists(csrfCookie)
      const response = await requesterContext.request.post(path, {
        maxRedirects: 0,
        form: {
          password: 'AnotherPassword123!',
          passwordConfirmation: 'AnotherPassword123!',
        },
        headers: {
          'x-xsrf-token': decodeURIComponent(csrfCookie!.value),
        },
      })
      assert.equal(response.status(), 302)
    }
    try {
      const first = await visit('/login')
      const second = await secondContext.visit('/login')
      for (const page of [first, second]) {
        await page.getByLabel('Email').fill(email)
        await page.getByLabel('Password').fill(originalPassword)
        await page.getByRole('button', { name: 'Sign in' }).click()
        await page.getByRole('heading', { name: 'Your dashboard is ready' }).waitFor()
        const protectedPage = await page.goto('/dashboard')
        assert.equal(protectedPage?.status(), 200)
        await page.getByRole('heading', { name: 'Your dashboard is ready' }).waitFor()
      }

      const assertOldCredentialsAndSessionsUnchanged = async () => {
        await owner.refresh()
        assert.equal(owner.password, originalHash)
        assert.equal((await User.verifyCredentials(email, originalPassword)).id, owner.id)
        for (const page of [first, second]) {
          const protectedPage = await page.goto('/dashboard')
          assert.equal(protectedPage?.status(), 200)
          await page.getByRole('heading', { name: 'Your dashboard is ready' }).waitFor()
        }
      }

      await first.goto('/reset-password/not-a-proof')
      await first.getByRole('heading', { name: 'This link can’t be used' }).waitFor()
      await submitProof('/reset-password/not-a-proof')
      await assertOldCredentialsAndSessionsUnchanged()

      const expiredToken = randomBytes(40).toString('base64url')
      const now = new Date()
      await db.table('password_reset_tokens').insert({
        tokenable_id: owner.id,
        email: owner.email,
        hash: createHash('sha256').update(expiredToken).digest('hex'),
        created_at: new Date(now.getTime() - 7200000).toISOString(),
        expires_at: new Date(now.getTime() - 3600000).toISOString(),
      })
      await first.goto(`/reset-password/${expiredToken}`)
      await first.getByRole('heading', { name: 'This link can’t be used' }).waitFor()
      await submitProof(`/reset-password/${expiredToken}`)
      await assertOldCredentialsAndSessionsUnchanged()

      const requester = await requesterContext.visit('/forgot-password')
      const requestLink = async () => {
        await requester.getByLabel('Email').fill(email)
        await requester.getByRole('button', { name: 'Send reset link' }).click()
        await requester
          .getByText('If an account exists for that address, we have sent a reset link.')
          .waitFor()
        assert.isAbove(resetUrls.length, 0)
        return new URL(resetUrls.at(-1)!).pathname
      }
      const firstProofPath = await requestLink()
      await requester.goto('/forgot-password')
      const replacementProofPath = await requestLink()
      assert.notEqual(replacementProofPath, firstProofPath)
      await first.goto(firstProofPath)
      await first.getByRole('heading', { name: 'This link can’t be used' }).waitFor()
      await submitProof(firstProofPath)
      await assertOldCredentialsAndSessionsUnchanged()

      await first.goto(replacementProofPath)
      await first.getByRole('heading', { name: 'Choose a new password' }).waitFor()
      await first.getByLabel('New password', { exact: true }).fill(replacementPassword)
      await first.getByLabel('Confirm new password').fill('DifferentPass123!')
      await first.getByRole('button', { name: 'Reset password' }).click()
      await first.getByRole('alert').waitFor()
      assert.equal(await first.getByLabel('New password', { exact: true }).inputValue(), '')
      assert.equal(await first.getByLabel('Confirm new password').inputValue(), '')
      await assertOldCredentialsAndSessionsUnchanged()

      await first.goto(replacementProofPath)
      await first.getByRole('heading', { name: 'Choose a new password' }).waitFor()
      await first.getByLabel('New password', { exact: true }).fill(replacementPassword)
      await first.getByLabel('Confirm new password').fill(replacementPassword)
      await first.getByRole('button', { name: 'Reset password' }).click()
      await first.getByRole('heading', { name: 'Welcome back' }).waitFor()
      for (const page of [first, second]) {
        await page.goto('/dashboard')
        assert.equal(new URL(page.url()).pathname, '/login')
      }

      await first.goto('/login')
      await first.getByLabel('Email').fill(email)
      await first.getByLabel('Password').fill(originalPassword)
      await first.getByRole('button', { name: 'Sign in' }).click()
      await first.getByText('Invalid email or password.').waitFor()
      assert.equal(new URL(first.url()).pathname, '/login')
      await assert.rejects(
        () => User.verifyCredentials(email, originalPassword),
        authErrors.E_INVALID_CREDENTIALS
      )

      await first.getByLabel('Email').fill(email)
      await first.getByLabel('Password').fill(replacementPassword)
      await first.getByRole('button', { name: 'Sign in' }).click()
      await first.getByRole('heading', { name: 'Your dashboard is ready' }).waitFor()
      await second.goto('/login')
      await second.getByLabel('Email').fill(email)
      await second.getByLabel('Password').fill(replacementPassword)
      await second.getByRole('button', { name: 'Sign in' }).click()
      await second.getByRole('heading', { name: 'Your dashboard is ready' }).waitFor()
      const currentSessions = async () => {
        for (const page of [first, second]) {
          assert.equal((await page.goto('/dashboard'))?.status(), 200)
          assert.equal(new URL(page.url()).pathname, '/dashboard')
        }
      }
      await currentSessions()
      const replacementHash = (await User.findOrFail(owner.id)).password

      await first.goto(replacementProofPath)
      await first.getByRole('heading', { name: 'This link can’t be used' }).waitFor()
      await first.getByRole('link', { name: 'Request a new link' }).waitFor()
      await owner.refresh()
      assert.equal((await User.verifyCredentials(email, replacementPassword)).id, owner.id)
      assert.equal(owner.password, replacementHash)
      await currentSessions()

      await submitProof(replacementProofPath)
      await owner.refresh()
      assert.equal(owner.password, replacementHash)
      assert.equal((await User.verifyCredentials(email, replacementPassword)).id, owner.id)
      await currentSessions()
    } finally {
      notify.passwordResetProvision = previousNotify
      await requesterContext.close()
      await secondContext.close()
    }
  })

  for (const inertia of [false, true]) {
    const representation = inertia ? 'Inertia' : 'HTML'

    test(`${representation}: reset success and consumed GET/POST protect original responses`, async ({
      assert,
    }) => {
      const proof = await recipeProof()
      const session = new RecipeProofSession(inertia)
      await session.prime()
      const read = await session.request(proof.path)
      assertProofHeaders(assert, read)
      assert.equal(read.status, 200)
      assert.include(await read.text(), '"valid":true')
      const complete = await session.request(
        `${proof.path}?token=${proof.token}&sentinel=completion`,
        {
          form: resetForm,
        }
      )
      assertProofHeaders(assert, complete)
      const login = await followProtected(assert, session, complete, '/login')
      const body = await login.text()
      assert.notInclude(body, proof.token)
      assert.notInclude(body, replacementPassword)
      assert.equal(
        (await User.verifyCredentials(proof.owner.email, replacementPassword)).id,
        proof.owner.id
      )
      assert.notExists(await db.from('password_reset_tokens').where('hash', proof.hash).first())
      const replacementHash = (await proof.owner.refresh()).password
      const consumed = await session.request(proof.path)
      assert.equal(consumed.status, 200)
      assertProofHeaders(assert, consumed)
      assert.include(await consumed.text(), '"valid":false')
      const replay = await session.request(`${proof.path}?token=${proof.token}`, {
        form: resetForm,
      })
      assertProofHeaders(assert, replay)
      const renewal = await followProtected(assert, session, replay, '/forgot-password')
      assert.include(await renewal.text(), 'This link is invalid or has expired.')
      assert.equal((await proof.owner.refresh()).password, replacementHash)
      assert.notExists(await db.from('password_reset_tokens').where('hash', proof.hash).first())
      assert.equal(
        (await User.verifyCredentials(proof.owner.email, replacementPassword)).id,
        proof.owner.id
      )
    })

    for (const expired of [false, true]) {
      test(`${representation}: ${expired ? 'expired' : 'malformed'} proof GET/POST and fixed renewal`, async ({
        assert,
      }) => {
        const proof = await recipeProof(expired)
        const path = expired ? proof.path : '/reset-password/not-a-proof'
        const session = new RecipeProofSession(inertia)
        await session.prime()
        const read = await session.request(path)
        assert.equal(read.status, 200)
        assertProofHeaders(assert, read)
        assert.include(await read.text(), '"valid":false')
        const rejected = await session.request(`${path}?token=${proof.token}&sentinel=invalid`, {
          form: resetForm,
          referer: 'https://untrusted.example/steal',
        })
        assertProofHeaders(assert, rejected)
        await assertStoredFlash(assert, 'This link is invalid or has expired.', [
          proof.token,
          replacementPassword,
        ])
        const renewal = await followProtected(assert, session, rejected, '/forgot-password')
        assert.include(await renewal.text(), 'This link is invalid or has expired.')
        await assertUnchanged(assert, proof)
      })
    }

    for (const state of ['malformed', 'expired', 'consumed'] as const) {
      test(`${representation}: ${state} proof validation visibly explains fixed renewal`, async ({
        assert,
      }) => {
        const proof = await recipeProof(state === 'expired')
        if (state === 'consumed')
          await db.from('password_reset_tokens').where('hash', proof.hash).delete()
        const path = state === 'malformed' ? '/reset-password/not-a-proof' : proof.path
        const session = new RecipeProofSession(inertia)
        await session.prime()
        const rejected = await session.request(`${path}?token=${proof.token}`, {
          form: { password: replacementPassword, passwordConfirmation: 'MismatchedSecret123!' },
          referer: 'https://untrusted.example/steal',
        })
        assertProofHeaders(assert, rejected)
        await assertStoredFlash(assert, 'passwordConfirmation', [
          proof.token,
          replacementPassword,
          'MismatchedSecret123!',
        ])
        await assertStoredFlash(assert, 'This link is invalid or has expired.', [
          proof.token,
          replacementPassword,
          'MismatchedSecret123!',
        ])
        const renewal = await followProtected(assert, session, rejected, '/forgot-password')
        const feedback = await renewal.text()
        assert.include(feedback, 'This link is invalid or has expired.')
        for (const secret of [proof.token, replacementPassword, 'MismatchedSecret123!'])
          assert.notInclude(feedback, secret)
        await proof.owner.refresh()
        assert.equal(proof.owner.password, proof.originalHash)
        assert.equal(
          (await User.verifyCredentials(proof.owner.email, originalPassword)).id,
          proof.owner.id
        )
        assert.equal(
          Boolean(await db.from('password_reset_tokens').where('hash', proof.hash).first()),
          state !== 'consumed'
        )
      })
    }

    test(`${representation}: malformed JSON fails before CSRF and allows protected retry`, async ({
      assert,
    }) => {
      const proof = await recipeProof()
      const session = new RecipeProofSession(inertia)
      await session.prime()
      const malformed = await session.request(`${proof.path}?token=${proof.token}`, {
        malformed: true,
        csrf: false,
      })
      assert.equal(malformed.status, 400)
      assertProofHeaders(assert, malformed)
      assert.isNull(malformed.headers.get('location'))
      // Malformed JSON is sent without CSRF: a parser rejection must win over CSRF recovery.
      const retried = await session.request(proof.path)
      assert.equal(retried.status, 200)
      assertProofHeaders(assert, retried)
      assert.include(await retried.text(), '"valid":true')
      await assertUnchanged(assert, proof)
    })

    test(`${representation}: unestablished proof CSRF uses fixed renewal and safe committed flash`, async ({
      assert,
    }) => {
      const session = new RecipeProofSession(inertia)
      await session.prime()
      const rejected = await session.request('/reset-password/not-a-proof?token=injected-bearer', {
        form: {
          ...resetForm,
          email: 'injected@example.test',
          token: 'injected-bearer',
          extra: 'injected-extra',
        },
        csrf: false,
        referer: 'https://untrusted.example/steal',
      })
      assertProofHeaders(assert, rejected)
      await assertStoredFlash(assert, 'The form expired.', [
        replacementPassword,
        'injected@example.test',
        'injected-bearer',
        'injected-extra',
      ])
      const renewal = await followProtected(assert, session, rejected, '/forgot-password')
      assert.include(await renewal.text(), 'The form expired.')
    })

    for (const referer of [undefined, 'https://untrusted.example/steal']) {
      for (const csrf of [false, true]) {
        test(`${representation}: ${csrf ? 'validation' : 'CSRF'} correction with ${referer ? 'hostile' : 'absent'} Referer`, async ({
          assert,
        }) => {
          const proof = await recipeProof()
          const session = new RecipeProofSession(inertia)
          await session.prime()
          const confirmation = csrf ? 'MismatchedSecret123!' : replacementPassword
          const rejected = await session.request(
            `${proof.path}?token=${proof.token}&sentinel=recovery`,
            {
              form: {
                password: replacementPassword,
                passwordConfirmation: confirmation,
                email: 'injected@example.test',
                token: proof.token,
                extra: 'injected-extra',
              },
              csrf,
              referer,
            }
          )
          assertProofHeaders(assert, rejected)
          await assertStoredFlash(assert, csrf ? 'passwordConfirmation' : 'The form expired.', [
            replacementPassword,
            confirmation,
            proof.token,
            'injected@example.test',
            'injected-extra',
          ])
          const recovered = await followProtected(assert, session, rejected, proof.path)
          const feedback = await recovered.text()
          assert.include(feedback, csrf ? 'passwordConfirmation' : 'The form expired.')
          assert.notInclude(feedback, replacementPassword)
          assert.notInclude(feedback, confirmation)
          await assertUnchanged(assert, proof)
          // The followed form supplies the real session's fresh XSRF cookie.
          const corrected = await session.request(
            `${proof.path}?token=${proof.token}&sentinel=corrected`,
            { form: resetForm }
          )
          assertProofHeaders(assert, corrected)
          const login = await followProtected(assert, session, corrected, '/login')
          const body = await login.text()
          assert.notInclude(body, proof.token)
          assert.notInclude(body, replacementPassword)
          assert.notExists(await db.from('password_reset_tokens').where('hash', proof.hash).first())
          assert.equal(
            (await User.verifyCredentials(proof.owner.email, replacementPassword)).id,
            proof.owner.id
          )
          await assert.rejects(
            () => User.verifyCredentials(proof.owner.email, originalPassword),
            authErrors.E_INVALID_CREDENTIALS
          )
        })
      }
    }
  }

  test('expired validation shows renewal feedback in the rendered browser', async ({
    visit,
    assert,
  }) => {
    const proof = await recipeProof()
    const page = await visit(proof.path)
    await db
      .from('password_reset_tokens')
      .where('hash', proof.hash)
      .update({ expires_at: new Date(Date.now() - 1000).toISOString() })
    await page.getByLabel('New password', { exact: true }).fill(replacementPassword)
    await page.getByLabel('Confirm new password').fill('MismatchedSecret123!')
    await page.getByRole('button', { name: 'Reset password', exact: true }).click()
    await page.waitForURL('**/forgot-password')
    await page
      .getByText('This link is invalid or has expired.', { exact: true })
      .waitFor({ state: 'visible' })
    assert.equal(new URL(page.url()).search, '')
    await assertUnchanged(assert, proof)
  })

  test('reset page suppresses the actual same-origin browser follow-on Referer', async ({
    visit,
    assert,
  }) => {
    const proof = await recipeProof()
    const page = await visit('/login')
    const response = await page.goto(new URL(proof.path, recipeOrigin).href)
    assert.equal(response!.headers()['cache-control'], 'no-store')
    assert.equal(response!.headers()['referrer-policy'], 'no-referrer')
    const followOn = page.waitForRequest(
      (request) => new URL(request.url()).pathname === '/forgot-password'
    )
    const status = await page.evaluate(async () => (await fetch('/forgot-password')).status)
    assert.equal(status, 200)
    const referrer = (await followOn).headers()['referer'] ?? ''
    assert.equal(referrer, '')
    if (process.env.PROOF_HEADER_EVIDENCE) {
      appendFileSync(
        process.env.PROOF_HEADER_EVIDENCE,
        JSON.stringify({ browser: true, family: 'reset-password', referrer }) + '\n'
      )
    }
    await assertUnchanged(assert, proof)
  })

  test('native signup with a mixed-case address keeps its session', async ({ visit, assert }) => {
    const email = `Signup-${randomUUID()}@Example.test`
    const page = await visit('/signup')
    await page.getByLabel('Full name').fill('New Recipe Account')
    await page.getByLabel('Email').fill(email)
    await page.getByLabel('Password', { exact: true }).fill(replacementPassword)
    await page.getByLabel('Confirm password').fill(replacementPassword)
    await page.getByRole('button', { name: 'Create account' }).click()
    await page.getByRole('heading', { name: 'Your dashboard is ready' }).waitFor()
    assert.equal((await page.goto('/dashboard'))?.status(), 200)
    assert.equal(new URL(page.url()).pathname, '/dashboard')
    assert.equal(
      (await User.findByOrFail('email', email.toLowerCase())).fullName,
      'New Recipe Account'
    )
  })
})
