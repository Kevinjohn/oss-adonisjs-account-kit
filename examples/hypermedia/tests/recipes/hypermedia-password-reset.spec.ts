/* eslint-disable @unicorn/no-await-expression-member, @unicorn/filename-case -- The recipe harness requires the filename to match its selector. */
// The recipe harness copies one spec: keep its lifecycle and table-driven response cases together.
import { createHash, randomBytes } from 'node:crypto'
import { test } from '@japa/runner'
import type { Assert } from '@japa/assert'
import { MessageBuilder } from '@adonisjs/core/helpers'
import { DateTime } from 'luxon'
import db from '@adonisjs/lucid/services/db'
import limiter from '@adonisjs/limiter/services/main'
import testUtils from '@adonisjs/core/services/test_utils'
import User from '#models/user'
import { accountKitNotifications } from '#services/account_kit_notifications'

const origin = process.env.APP_URL!

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
    return response
  }

  async prime() {
    await this.request('/login')
    if (!this.csrf) throw new Error('The native login form did not render a CSRF token')
  }
}

test.group('existing Edge application password reset', (group) => {
  group.each.setup(async () => {
    const cleanup = await testUtils.db().truncate()
    await cleanup()
    await db
      .table('account_transaction_lock')
      .insert({ id: 1, version: 0 })
      .onConflict('id')
      .ignore()
    await limiter.clear(['memory'])
    return cleanup
  })

  test('the native signup auto-login keeps access to its protected dashboard', async ({
    browser,
  }) => {
    const context = await browser.newContext({ baseURL: origin, javaScriptEnabled: false })
    try {
      const page = await context.visit('/signup')
      await page.getByLabel('Full name').fill('New Starter User')
      // A mixed-case address must still sign in through Account Kit's normalized lookup.
      await page.getByLabel('Email').fill('New-Starter@Example.test')
      await page.getByLabel('Password', { exact: true }).fill('SignupPass123!')
      await page.getByLabel('Confirm password').fill('SignupPass123!')
      await page.getByRole('button', { name: 'Create account' }).click()
      await page.getByRole('heading', { name: 'Your dashboard is ready' }).waitFor()
      await page.goto('/dashboard')
      await page.getByRole('heading', { name: 'Your dashboard is ready' }).waitFor()
      await User.findByOrFail('email', 'new-starter@example.test')
    } finally {
      await context.close()
    }
  })

  test('two original-login sessions lose protected access and only the new password works', async ({
    browser,
    assert,
  }) => {
    accountKitNotifications.clear()
    const user = await User.create({
      fullName: 'Starter Owner',
      email: 'owner@example.test',
      password: 'OldPassword123!',
      emailVerifiedAt: DateTime.now(),
      unverifiedEmail: null,
    })
    const firstContext = await browser.newContext({ baseURL: origin, javaScriptEnabled: false })
    const secondContext = await browser.newContext({ baseURL: origin, javaScriptEnabled: false })
    const consumedContext = await browser.newContext({ baseURL: origin, javaScriptEnabled: false })
    try {
      const requester = await firstContext.visit('/forgot-password')
      await requester.getByLabel('Email').fill(user.email)
      await requester.getByRole('button', { name: 'Send reset link' }).click()
      await requester
        .getByText('If an account exists for that address, we have sent a reset link.')
        .waitFor()
      const token = accountKitNotifications.tokenFor('passwordResetProvision', user.email)
      const resetPath = `/reset-password/${encodeURIComponent(token)}`

      for (const context of [firstContext, secondContext]) {
        const login = await context.visit('/login')
        await login.getByLabel('Email').fill(user.email)
        await login.getByLabel('Password').fill('OldPassword123!')
        await login.getByRole('button', { name: 'Sign in' }).click()
        await login.getByRole('heading', { name: 'Your dashboard is ready' }).waitFor()
        await login.goto('/dashboard')
        await login.getByRole('heading', { name: 'Your dashboard is ready' }).waitFor()
      }

      const secondSession = await consumedContext.visit(resetPath)
      await secondSession.getByRole('heading', { name: 'Choose a new password' }).waitFor()
      await requester.goto(resetPath)
      await requester.getByLabel('New password').fill('NewPassword123!')
      await requester.getByLabel('Confirm password').fill('NewPassword123!')
      await requester.getByRole('button', { name: 'Reset password' }).click()
      await requester.waitForURL('**/login')
      await requester
        .getByText('Your password has been reset. Sign in with the new password.')
        .waitFor()
      const newPasswordHash = (await db
        .from('users')
        .select('password')
        .where('id', user.id)
        .first())!.password

      for (const context of [firstContext, secondContext]) {
        const protectedPage = await context.visit('/dashboard')
        await protectedPage.waitForURL('**/login')
        await protectedPage.getByRole('heading', { name: 'Welcome back' }).waitFor()
      }

      await requester.goto('/login')
      await requester.getByLabel('Email').fill(user.email)
      await requester.getByLabel('Password').fill('OldPassword123!')
      await requester.getByRole('button', { name: 'Sign in' }).click()
      await requester.waitForURL('**/login')
      assert.include(
        await requester.locator('body').innerText(),
        'The email or password is incorrect. Check your details and try again.'
      )
      await requester.getByLabel('Password').fill('NewPassword123!')
      await requester.getByRole('button', { name: 'Sign in' }).click()
      await requester.getByRole('heading', { name: 'Your dashboard is ready' }).waitFor()
      await requester.goto('/dashboard')
      await requester.getByRole('heading', { name: 'Your dashboard is ready' }).waitFor()
      const assertCurrentSession = async () => {
        const response = await firstContext.request.get(`${origin}/dashboard`, { maxRedirects: 0 })
        assert.equal(response.status(), 200)
        assert.equal(new URL(response.url()).pathname, '/dashboard')
      }
      await assertCurrentSession()
      await secondSession.getByLabel('New password').fill('AnotherPassword123!')
      await secondSession.getByLabel('Confirm password').fill('AnotherPassword123!')
      await secondSession.getByRole('button', { name: 'Reset password' }).click()
      await secondSession
        .getByText(/This reset link is invalid, already used, or expired/)
        .waitFor()
      assert.isNotNull(await User.verifyCredentials(user.email, 'NewPassword123!'))
      assert.equal(
        (await db.from('users').select('password').where('id', user.id).first())!.password,
        newPasswordHash
      )

      await assertCurrentSession()
      await requester.goto(resetPath)
      await requester.getByText(/invalid, already used, or expired/).waitFor()
      await assertCurrentSession()
    } finally {
      await firstContext.close()
      await secondContext.close()
      await consumedContext.close()
    }
  })

  test('malformed and expired reset POSTs leave the password hash and active proof unchanged', async ({
    browser,
    assert,
  }) => {
    accountKitNotifications.clear()
    const user = await User.create({
      fullName: 'Proof Owner',
      email: 'proof@example.test',
      password: 'OldPassword123!',
      emailVerifiedAt: DateTime.now(),
      unverifiedEmail: null,
    })
    const expired = randomBytes(40).toString('base64url')
    const expiredHash = createHash('sha256').update(expired).digest('hex')
    const now = new Date()
    await db.table('password_reset_tokens').insert({
      tokenable_id: user.id,
      email: user.email,
      hash: expiredHash,
      expires_at: new Date(now.getTime() - 60_000).toISOString(),
      created_at: new Date(now.getTime() - 120_000).toISOString(),
    })
    const expiredProof = await db
      .from('password_reset_tokens')
      .where('tokenable_id', user.id)
      .where('hash', expiredHash)
      .first()
    assert.isNotNull(expiredProof)
    const formOwner = await User.create({
      fullName: 'Form Owner',
      email: 'form-owner@example.test',
      password: 'OldPassword123!',
      emailVerifiedAt: DateTime.now(),
      unverifiedEmail: null,
    })
    const originalHash = (await db.from('users').select('password').where('id', user.id).first())!
      .password
    const formOwnerHash = (await db
      .from('users')
      .select('password')
      .where('id', formOwner.id)
      .first())!.password
    const context = await browser.newContext({ baseURL: origin, javaScriptEnabled: false })
    try {
      const page = await context.visit('/forgot-password')
      await page.getByLabel('Email').fill(formOwner.email)
      await page.getByRole('button', { name: 'Send reset link' }).click()
      await page
        .getByText('If an account exists for that address, we have sent a reset link.')
        .waitFor()
      const valid = accountKitNotifications.tokenFor('passwordResetProvision', formOwner.email)
      const validHash = createHash('sha256').update(valid).digest('hex')
      const validProof = await db
        .from('password_reset_tokens')
        .where('tokenable_id', formOwner.id)
        .where('hash', validHash)
        .first()
      assert.isNotNull(validProof)
      const ownerSession = await context.visit('/login')
      await ownerSession.getByLabel('Email').fill(user.email)
      await ownerSession.getByLabel('Password').fill('OldPassword123!')
      await ownerSession.getByRole('button', { name: 'Sign in' }).click()
      await ownerSession.waitForURL('**/dashboard')
      const formContext = await browser.newContext({ baseURL: origin, javaScriptEnabled: false })
      try {
        const formSession = await formContext.visit('/login')
        await formSession.getByLabel('Email').fill(formOwner.email)
        await formSession.getByLabel('Password').fill('OldPassword123!')
        await formSession.getByRole('button', { name: 'Sign in' }).click()
        await formSession.waitForURL('**/dashboard')
        const assertActiveSessions = async () => {
          for (const client of [ownerSession, formSession]) {
            const response = await client.request.get(`${origin}/dashboard`, { maxRedirects: 0 })
            assert.equal(response.status(), 200)
            assert.equal(new URL(response.url()).pathname, '/dashboard')
          }
        }
        for (const token of ['not-a-proof', expired]) {
          await assertActiveSessions()
          await page.goto(`/reset-password/${encodeURIComponent(valid)}`)
          await page
            .locator('form')
            .evaluate(
              (form, action) => form.setAttribute('action', action),
              `/reset-password/${encodeURIComponent(token)}`
            )
          await page.getByLabel('New password').fill('ReplacementPass123!')
          await page.getByLabel('Confirm password').fill('ReplacementPass123!')
          await page.getByRole('button', { name: 'Reset password' }).click()
          assert.equal(
            (await db.from('users').select('password').where('id', user.id).first())!.password,
            originalHash
          )
          assert.equal(
            (await db.from('users').select('password').where('id', formOwner.id).first())!.password,
            formOwnerHash
          )
          await page.getByText(/This reset link is invalid, already used, or expired/).waitFor()
          assert.equal(
            (await db.from('users').select('password').where('id', user.id).first())!.password,
            originalHash
          )
          assert.deepEqual(
            await db
              .from('password_reset_tokens')
              .where('tokenable_id', user.id)
              .where('hash', expiredHash)
              .first(),
            expiredProof
          )
          assert.deepEqual(
            await db
              .from('password_reset_tokens')
              .where('tokenable_id', formOwner.id)
              .where('hash', validHash)
              .first(),
            validProof
          )
          await assertActiveSessions()
        }
      } finally {
        await formContext.close()
      }
    } finally {
      await context.close()
    }
  })

  test('mismatch clears password fields and a replacement proof rejects the old proof by POST', async ({
    browser,
    assert,
  }) => {
    accountKitNotifications.clear()
    const user = await User.create({
      fullName: 'Recovery Owner',
      email: 'recovery@example.test',
      password: 'OldPassword123!',
      emailVerifiedAt: DateTime.now(),
      unverifiedEmail: null,
    })
    const context = await browser.newContext({ baseURL: origin, javaScriptEnabled: false })
    try {
      const page = await context.visit('/forgot-password')
      await page.getByLabel('Email').fill(user.email)
      await page.getByRole('button', { name: 'Send reset link' }).click()
      await page
        .getByText('If an account exists for that address, we have sent a reset link.')
        .waitFor()
      const first = accountKitNotifications.tokenFor('passwordResetProvision', user.email)
      await page.goto('/forgot-password')
      await page.getByLabel('Email').fill(user.email)
      await page.getByRole('button', { name: 'Send reset link' }).click()
      await page
        .getByText('If an account exists for that address, we have sent a reset link.')
        .waitFor()
      const replacement = accountKitNotifications.tokenFor('passwordResetProvision', user.email)
      const originalHash = (await db.from('users').select('password').where('id', user.id).first())!
        .password
      const replacementHash = createHash('sha256').update(replacement).digest('hex')
      const replacementProof = await db
        .from('password_reset_tokens')
        .where('tokenable_id', user.id)
        .where('hash', replacementHash)
        .first()
      assert.isNotNull(replacementProof)
      await page.goto('/login')
      await page.getByLabel('Email').fill(user.email)
      await page.getByLabel('Password').fill('OldPassword123!')
      await page.getByRole('button', { name: 'Sign in' }).click()
      await page.waitForURL('**/dashboard')
      const assertPreserved = async () => {
        const response = await context.request.get(`${origin}/dashboard`, { maxRedirects: 0 })
        assert.equal(response.status(), 200)
        assert.equal(new URL(response.url()).pathname, '/dashboard')
        assert.equal(
          (await db.from('users').select('password').where('id', user.id).first())!.password,
          originalHash
        )
        assert.deepEqual(
          await db
            .from('password_reset_tokens')
            .where('tokenable_id', user.id)
            .where('hash', replacementHash)
            .first(),
          replacementProof
        )
      }
      await assertPreserved()

      await page.goto(`/reset-password/${encodeURIComponent(replacement)}`)
      await page.getByLabel('New password').fill('ReplacementPass123!')
      await page.getByLabel('Confirm password').fill('DifferentPass123!')
      const validationResponse = page.waitForResponse(
        (response) =>
          response.request().method() === 'POST' &&
          new URL(response.url()).pathname.startsWith('/reset-password/')
      )
      await page.getByRole('button', { name: 'Reset password' }).click()
      const response = await validationResponse
      assert.equal(response.headers()['cache-control'], 'no-store')
      assert.equal(response.headers()['referrer-policy'], 'no-referrer')
      const confirmationField = page
        .locator('.field')
        .filter({ has: page.getByLabel('Confirm password') })
      const confirmationErrorLocator = confirmationField.locator('.field__error')
      const responseBody = await page.locator('body').innerText()
      assert.isTrue(
        await confirmationErrorLocator.isVisible(),
        `Expected visible confirmation error after ${response.status()} ${response.url()}; page ${page.url()} contained: ${responseBody}`
      )
      const confirmationError = await confirmationErrorLocator.innerText()
      assert.isNotEmpty(confirmationError.trim())
      assert.equal(await page.getByLabel('New password').inputValue(), '')
      assert.equal(await page.getByLabel('Confirm password').inputValue(), '')
      assert.isNotNull(await User.verifyCredentials(user.email, 'OldPassword123!'))
      await assertPreserved()

      await page.goto(`/reset-password/${encodeURIComponent(replacement)}`)
      await page
        .locator('form')
        .evaluate(
          (form, action) => form.setAttribute('action', action),
          `/reset-password/${encodeURIComponent(first)}`
        )
      await page.getByLabel('New password').fill('ReplacementPass123!')
      await page.getByLabel('Confirm password').fill('ReplacementPass123!')
      await page.getByRole('button', { name: 'Reset password' }).click()
      await page.getByText(/This reset link is invalid, already used, or expired/).waitFor()
      assert.isNotNull(await User.verifyCredentials(user.email, 'OldPassword123!'))
      await assertPreserved()

      await page.goto(`/reset-password/${encodeURIComponent(replacement)}`)
      await page.getByLabel('New password').fill('ReplacementPass123!')
      await page.getByLabel('Confirm password').fill('ReplacementPass123!')
      await page.getByRole('button', { name: 'Reset password' }).click()
      await page.waitForURL('**/login')
      await page.getByText('Your password has been reset. Sign in with the new password.').waitFor()
      assert.equal((await User.verifyCredentials(user.email, 'ReplacementPass123!')).id, user.id)
      assert.notExists(
        await db.from('password_reset_tokens').where('hash', replacementHash).first()
      )
      const revoked = await context.request.get(`${origin}/dashboard`, { maxRedirects: 0 })
      assert.equal(revoked.status(), 302)
      assert.equal(new URL(revoked.headers()['location'], origin).pathname, '/login')
    } finally {
      await context.close()
    }
  })
})

async function recipeProof(expired = false) {
  const token = randomBytes(40).toString('base64url')
  const owner = await User.create({
    fullName: 'Boundary Owner',
    email: 'boundary@example.test',
    password: 'OriginalPass123!',
  })
  const hash = createHash('sha256').update(token).digest('hex')
  const now = new Date()
  await db.table('password_reset_tokens').insert({
    tokenable_id: owner.id,
    email: owner.email,
    hash,
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + (expired ? -1000 : 3600000)).toISOString(),
  })
  return { owner, token, hash, path: `/reset-password/${token}` }
}

function protectedResponse(assert: Assert, response: Response) {
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer')
}

async function destination(
  assert: Assert,
  session: ProofSession,
  response: Response,
  path: string
) {
  assert.equal(response.status, 302)
  const location = new URL(response.headers.get('location')!, origin)
  assert.equal(location.origin, origin)
  assert.equal(location.pathname, path)
  assert.equal(location.search, '')
  const followed = await session.request(path)
  assert.equal(followed.status, 200)
  if (path.startsWith('/reset-password/')) protectedResponse(assert, followed)
  return followed
}

/** Read the real database session after the request commits and before following consumes flash. */
async function storedFeedback(assert: Assert, expected: string, secrets: string[]) {
  const rows = await db.from('sessions').select('id', 'data')
  assert.isNotEmpty(rows)
  const flashes = rows
    .map((row) => {
      const data = new MessageBuilder().verify(row.data, row.id)
      assert.isNotNull(data)
      return (data as { __flash__?: Record<string, unknown> }).__flash__
    })
    .filter(Boolean)
  assert.isNotEmpty(flashes)
  const stored = JSON.stringify(flashes)
  assert.include(stored, expected)
  assert.notInclude(stored, '"input"')
  for (const secret of secrets) assert.notInclude(stored, secret)
}

const resetForm = { password: 'CorrectedPass123!', passwordConfirmation: 'CorrectedPass123!' }
const csrfMessage = 'Invalid or expired CSRF token'

test.group('native reset recipe response boundary', (group) => {
  group.each.setup(async () => {
    const cleanup = await testUtils.db().truncate()
    await cleanup()
    await db
      .table('account_transaction_lock')
      .insert({ id: 1, version: 0 })
      .onConflict('id')
      .ignore()
    await limiter.clear(['memory'])
    return cleanup
  })

  test('HTML valid GET, success and consumed recovery protect original responses', async ({
    assert,
  }) => {
    const proof = await recipeProof()
    const session = new ProofSession()
    await session.prime()
    const read = await session.request(proof.path)
    protectedResponse(assert, read)
    assert.equal(read.status, 200)
    assert.include(await read.text(), `action="${proof.path}"`)
    assert.exists(await db.from('password_reset_tokens').where('hash', proof.hash).first())
    const done = await session.request(`${proof.path}?token=${proof.token}&sentinel=success`, {
      form: resetForm,
    })
    protectedResponse(assert, done)
    await storedFeedback(assert, 'Your password has been reset', [
      proof.token,
      resetForm.password,
      'sentinel',
    ])
    const login = await destination(assert, session, done, '/login')
    assert.include(await login.text(), 'Your password has been reset')
    assert.equal(
      (await User.verifyCredentials(proof.owner.email, resetForm.password)).id,
      proof.owner.id
    )
    assert.notExists(await db.from('password_reset_tokens').where('hash', proof.hash).first())
    const user = await db.from('users').where('id', proof.owner.id).first()
    const consumed = await session.request(proof.path)
    protectedResponse(assert, consumed)
    assert.include(await consumed.text(), 'This link is invalid, already used, or expired')
    const replay = await session.request(`${proof.path}?token=${proof.token}`, { form: resetForm })
    protectedResponse(assert, replay)
    const renewed = await destination(assert, session, replay, '/forgot-password')
    assert.include(await renewed.text(), 'This reset link is invalid')
    assert.deepEqual(await db.from('users').where('id', proof.owner.id).first(), user)
    const invalidReplay = await session.request(
      `${proof.path}?token=${proof.token}&sentinel=validation`,
      {
        form: {
          ...resetForm,
          passwordConfirmation: 'MismatchSecret123!',
          extra: 'PrivateExtraField',
        },
      }
    )
    protectedResponse(assert, invalidReplay)
    await storedFeedback(assert, 'This reset link is invalid', [
      proof.token,
      resetForm.password,
      'MismatchSecret123!',
      'PrivateExtraField',
    ])
    const validationRenewal = await destination(assert, session, invalidReplay, '/forgot-password')
    assert.include(await validationRenewal.text(), 'This reset link is invalid')
    assert.deepEqual(await db.from('users').where('id', proof.owner.id).first(), user)
    assert.notExists(await db.from('password_reset_tokens').where('hash', proof.hash).first())
  })

  for (const state of ['malformed', 'expired'] as const) {
    for (const failure of ['invalid', 'validation', 'csrf'] as const) {
      test(`HTML ${state} proof ${failure} uses fixed renewal and preserves state`, async ({
        assert,
      }) => {
        const proof = await recipeProof(state === 'expired')
        const session = new ProofSession()
        await session.prime()
        const path = state === 'expired' ? proof.path : '/reset-password/not-a-proof'
        const beforeProof = await db.from('password_reset_tokens').where('hash', proof.hash).first()
        const beforeUser = await db.from('users').where('id', proof.owner.id).first()
        const read = await session.request(path)
        protectedResponse(assert, read)
        assert.equal(read.status, 200)
        assert.include(await read.text(), 'This link is invalid, already used, or expired')
        const rejected = await session.request(`${path}?token=${proof.token}&sentinel=renewal`, {
          form: {
            ...resetForm,
            passwordConfirmation:
              failure === 'validation' ? 'MismatchSecret123!' : resetForm.passwordConfirmation,
            extra: 'PrivateExtraField',
          },
          csrf: failure !== 'csrf',
          referer: 'https://untrusted.example/steal',
        })
        protectedResponse(assert, rejected)
        const expected = failure === 'csrf' ? csrfMessage : 'This reset link is invalid'
        await storedFeedback(assert, expected, [
          proof.token,
          resetForm.password,
          'MismatchSecret123!',
          'PrivateExtraField',
        ])
        const recovered = await destination(assert, session, rejected, '/forgot-password')
        assert.include(await recovered.text(), expected)
        assert.deepEqual(
          await db.from('password_reset_tokens').where('hash', proof.hash).first(),
          beforeProof
        )
        assert.deepEqual(await db.from('users').where('id', proof.owner.id).first(), beforeUser)
      })
    }
  }

  for (const method of ['GET', 'HEAD', 'OPTIONS', 'PUT', 'PATCH']) {
    for (const referer of [
      undefined,
      'https://untrusted.example/steal',
      `${origin}/login?token=private-referrer-query`,
    ]) {
      test(`HTML _method=${method}, ${referer ?? 'absent'} Referer keeps Shield and correction authoritative`, async ({
        assert,
      }) => {
        const proof = await recipeProof()
        const session = new ProofSession()
        await session.prime()
        const beforeProof = await db.from('password_reset_tokens').where('hash', proof.hash).first()
        const beforeUser = await db.from('users').where('id', proof.owner.id).first()
        const form = {
          ...resetForm,
          _method: method,
          passwordConfirmation: 'MismatchSecret123!',
          extra: 'PrivateExtraField',
          email: proof.token,
        }
        const path = `${proof.path}?token=${proof.token}&sentinel=correction`
        const csrf = await session.request(path, { form, csrf: false, referer })
        protectedResponse(assert, csrf)
        await storedFeedback(assert, csrfMessage, [
          proof.token,
          resetForm.password,
          form.passwordConfirmation,
          form.extra,
          'private-referrer-query',
        ])
        const retry = await destination(assert, session, csrf, proof.path)
        assert.include(await retry.text(), csrfMessage)
        const invalid = await session.request(path, { form, referer })
        protectedResponse(assert, invalid)
        await storedFeedback(assert, 'passwordConfirmation', [
          proof.token,
          resetForm.password,
          form.passwordConfirmation,
          form.extra,
          'private-referrer-query',
        ])
        const correction = await destination(assert, session, invalid, proof.path)
        assert.include(await correction.text(), 'field__error')
        assert.deepEqual(
          await db.from('password_reset_tokens').where('hash', proof.hash).first(),
          beforeProof
        )
        assert.deepEqual(await db.from('users').where('id', proof.owner.id).first(), beforeUser)
        const corrected = await session.request(path, {
          form: { ...resetForm, _method: method },
          referer,
        })
        protectedResponse(assert, corrected)
        await destination(assert, session, corrected, '/login')
        assert.equal(
          (await User.verifyCredentials(proof.owner.email, resetForm.password)).id,
          proof.owner.id
        )
        assert.notExists(await db.from('password_reset_tokens').where('hash', proof.hash).first())
      })
    }
  }

  for (const variant of ['encoded', 'trailing-slash', 'encoded-separator'] as const) {
    test(`HTML ${variant} CSRF recovery uses an inspected canonical destination`, async ({
      assert,
    }) => {
      const proof = await recipeProof()
      const session = new ProofSession()
      await session.prime()
      const encoded = `%${proof.token.charCodeAt(0).toString(16)}${proof.token.slice(1)}`
      const path =
        variant === 'encoded'
          ? `/reset-password/${encoded}`
          : variant === 'trailing-slash'
            ? `${proof.path}/`
            : `${proof.path}%2Fextra`
      const rejected = await session.request(`${path}?token=${proof.token}`, {
        form: resetForm,
        csrf: false,
      })
      protectedResponse(assert, rejected)
      const recovered = await destination(
        assert,
        session,
        rejected,
        variant === 'encoded-separator' ? '/forgot-password' : proof.path
      )
      assert.include(await recovered.text(), csrfMessage)
      assert.exists(await db.from('password_reset_tokens').where('hash', proof.hash).first())
    })
  }

  test('HTML parser rejection is protected before Shield or validation', async ({ assert }) => {
    const proof = await recipeProof()
    const session = new ProofSession()
    await session.prime()
    const beforeUser = await db.from('users').where('id', proof.owner.id).first()
    const beforeProof = await db.from('password_reset_tokens').where('hash', proof.hash).first()
    const rejected = await session.request(`${proof.path}?token=${proof.token}`, {
      malformed: true,
    })
    assert.equal(rejected.status, 400)
    protectedResponse(assert, rejected)
    assert.equal(rejected.headers.get('location'), null)
    const retry = await session.request(proof.path)
    assert.equal(retry.status, 200)
    protectedResponse(assert, retry)
    assert.deepEqual(await db.from('users').where('id', proof.owner.id).first(), beforeUser)
    assert.deepEqual(
      await db.from('password_reset_tokens').where('hash', proof.hash).first(),
      beforeProof
    )
  })

  for (const state of ['expired', 'consumed'] as const) {
    test(`no-JavaScript ${state} proof validation shows renewal feedback`, async ({
      browser,
      assert,
    }) => {
      const proof = await recipeProof()
      const context = await browser.newContext({ baseURL: origin, javaScriptEnabled: false })
      try {
        const page = await context.visit(proof.path)
        await page.getByLabel('New password').fill(resetForm.password)
        await page.getByLabel('Confirm password').fill('MismatchSecret123!')
        await page
          .locator('form')
          .evaluate(
            (form, action) => form.setAttribute('action', action),
            `${proof.path}?token=${proof.token}&sentinel=stale-validation`
          )
        // Keep the genuine loaded form while its proof expires or another browser consumes it.
        if (state === 'expired') {
          await db
            .from('password_reset_tokens')
            .where('hash', proof.hash)
            .update({
              expires_at: new Date(Date.now() - 1000).toISOString(),
            })
        } else {
          const completing = new ProofSession()
          await completing.prime()
          const done = await completing.request(proof.path, { form: resetForm })
          protectedResponse(assert, done)
          await destination(assert, completing, done, '/login')
        }
        const beforeUser = await db.from('users').where('id', proof.owner.id).first()
        const beforeProof = await db.from('password_reset_tokens').where('hash', proof.hash).first()
        const submission = page.waitForResponse(
          (response) =>
            response.request().method() === 'POST' &&
            new URL(response.url()).pathname === proof.path
        )
        await page.getByRole('button', { name: 'Reset password' }).click()
        const response = await submission
        assert.equal(response.status(), 302)
        assert.equal(response.headers()['cache-control'], 'no-store')
        assert.equal(response.headers()['referrer-policy'], 'no-referrer')
        const location = new URL(response.headers()['location'], origin)
        assert.equal(location.origin, origin)
        assert.equal(location.pathname, '/forgot-password')
        assert.equal(location.search, '')
        await page.waitForURL('**/forgot-password')
        await page
          .getByText(
            'This reset link is invalid, already used, or expired. Request a fresh link.',
            { exact: true }
          )
          .waitFor()
        const body = await page.locator('body').innerText()
        for (const secret of [proof.token, resetForm.password, 'MismatchSecret123!']) {
          assert.notInclude(body, secret)
        }
        assert.deepEqual(await db.from('users').where('id', proof.owner.id).first(), beforeUser)
        assert.deepEqual(
          await db.from('password_reset_tokens').where('hash', proof.hash).first(),
          beforeProof
        )
      } finally {
        await context.close()
      }
    })
  }

  test('no-JavaScript correction retains the unrelated visitor and sends no same-origin referrer', async ({
    browser,
    assert,
  }) => {
    const proof = await recipeProof()
    const other = await User.create({
      fullName: 'Unrelated Visitor',
      email: 'visitor@example.test',
      password: 'VisitorPass123!',
    })
    const context = await browser.newContext({ baseURL: origin, javaScriptEnabled: false })
    try {
      const page = await context.visit('/login')
      await page.getByLabel('Email').fill(other.email)
      await page.getByLabel('Password').fill('VisitorPass123!')
      await page.getByRole('button', { name: 'Sign in' }).click()
      await page.waitForURL('**/dashboard')
      // A server-side native session must remain the visitor's after another user's reset.
      const sessionsBefore = await db.from('sessions').select('id', 'data')
      const visitorSession = sessionsBefore.find(
        (row) =>
          String(
            (new MessageBuilder().verify(row.data, row.id) as { auth_web?: unknown })?.auth_web
          ) === String(other.id)
      )
      assert.exists(visitorSession)
      const read = await page.goto(proof.path)
      assert.equal(read!.headers()['referrer-policy'], 'no-referrer')
      const navigation = page.waitForRequest((request) => new URL(request.url()).pathname === '/')
      await page.getByRole('link', { name: 'AdonisJS', exact: true }).click()
      assert.equal((await navigation).headers()['referer'] ?? '', '')
      await page.goto(proof.path)
      const csrf = await page.request.post(`${origin}${proof.path}?token=${proof.token}`, {
        form: resetForm,
        maxRedirects: 0,
      })
      assert.equal(csrf.status(), 302)
      assert.equal(csrf.headers()['cache-control'], 'no-store')
      assert.equal(csrf.headers()['referrer-policy'], 'no-referrer')
      assert.equal(new URL(csrf.headers()['location'], origin).pathname, proof.path)
      assert.equal(new URL(csrf.headers()['location'], origin).search, '')
      await page.goto(proof.path)
      await page.getByText(csrfMessage, { exact: true }).first().waitFor()
      await page.getByLabel('New password').fill(resetForm.password)
      await page.getByLabel('Confirm password').fill('MismatchSecret123!')
      await page.getByRole('button', { name: 'Reset password' }).click()
      await page.locator('.field__error').waitFor()
      assert.equal(await page.getByLabel('New password').inputValue(), '')
      assert.equal(await page.getByLabel('Confirm password').inputValue(), '')
      await page.getByLabel('New password').fill(resetForm.password)
      await page.getByLabel('Confirm password').fill(resetForm.password)
      await page.getByRole('button', { name: 'Reset password' }).click()
      // The starter guest middleware redirects a signed-in unrelated visitor to home.
      await page.waitForURL(origin + '/')
      const protectedPage = await context.request.get(`${origin}/dashboard`, { maxRedirects: 0 })
      assert.equal(protectedPage.status(), 200)
      const row = await db.from('sessions').where('id', visitorSession!.id).firstOrFail()
      const identity = new MessageBuilder().verify(row.data, row.id) as { auth_web?: unknown }
      assert.equal(String(identity.auth_web), String(other.id))
      assert.equal(
        (await User.verifyCredentials(proof.owner.email, resetForm.password)).id,
        proof.owner.id
      )
      assert.equal((await User.verifyCredentials(other.email, 'VisitorPass123!')).id, other.id)
      assert.notExists(await db.from('password_reset_tokens').where('hash', proof.hash).first())
    } finally {
      await context.close()
    }
  })
})
