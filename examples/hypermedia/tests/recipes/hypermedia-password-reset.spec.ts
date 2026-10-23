/* eslint-disable @unicorn/filename-case -- The recipe harness requires the filename to match its selector. */
import { createHash, randomBytes } from 'node:crypto'
import { test } from '@japa/runner'
import { DateTime } from 'luxon'
import db from '@adonisjs/lucid/services/db'
import limiter from '@adonisjs/limiter/services/main'
import testUtils from '@adonisjs/core/services/test_utils'
import User from '#models/user'
import { accountKitNotifications } from '#services/account_kit_notifications'

const origin = process.env.APP_URL!

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

      const secondSession = await secondContext.visit(resetPath)
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
    } finally {
      await firstContext.close()
      await secondContext.close()
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
      for (const token of ['not-a-proof', expired]) {
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
      assert.isNotNull(
        await db.from('password_reset_tokens').where('tokenable_id', user.id).first()
      )
    } finally {
      await context.close()
    }
  })
})
