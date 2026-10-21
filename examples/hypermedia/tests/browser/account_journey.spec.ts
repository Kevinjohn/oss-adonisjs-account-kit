/* eslint-disable @unicorn/no-await-expression-member -- Each browser action is asserted beside the state it produces. */

import { test } from '@japa/runner'
import { DateTime } from 'luxon'
import User from '#models/user'
import { accountKitNotifications } from '#services/account_kit_notifications'
import { setupAccountDatabase } from '#tests/helpers/account_database'

const origin = process.env.APP_URL!

test.group('native account journeys', (group) => {
  group.each.setup(setupAccountDatabase)

  test('signup stays limited until one-use email confirmation, then opens protected access', async ({
    visit,
    assert,
  }) => {
    accountKitNotifications.clear()
    const page = await visit('/signup')
    await page.getByLabel('Full name').fill('Taylor Example')
    await page.getByLabel('Email').fill('taylor@example.test')
    await page.getByLabel('Password', { exact: true }).fill('SignupPass123!')
    await page.getByLabel('Confirm password').fill('SignupPass123!')
    await page.getByRole('button', { name: 'Create account' }).click()
    await page.getByRole('heading', { name: 'Your account' }).waitFor()

    const user = await User.findByOrFail('email', 'taylor@example.test')
    assert.isNull(user.emailVerifiedAt)
    assert.equal(user.unverifiedEmail, user.email)
    await page.goto('/account')
    await page.getByRole('heading', { name: 'Your account' }).waitFor()
    assert.equal(new URL(page.url()).pathname, '/dashboard')

    const token = accountKitNotifications.tokenFor('accountActivationProvision', user.email)
    const proofPath = `/verify-email/${encodeURIComponent(token)}`
    await page.goto(proofPath)
    await page.getByRole('heading', { name: 'Confirm your email' }).waitFor()
    assert.equal((await User.findByOrFail('id', user.id)).emailVerifiedAt, null)
    await page.goto('/dashboard')
    await page.getByText('Signed in as taylor@example.test.').waitFor()
    await page.goto(proofPath)
    await page.getByLabel('Choose a password').fill('ClaimedPass123!')
    await page.getByLabel('Confirm password').fill('ClaimedPass123!')
    await page.getByRole('button', { name: 'Confirm email' }).click()
    await page.getByRole('heading', { name: 'Sign in' }).waitFor()
    assert.isNotNull((await User.findByOrFail('id', user.id)).emailVerifiedAt)

    await page.getByLabel('Email').fill(user.email)
    await page.getByLabel('Password').fill('ClaimedPass123!')
    await page.getByRole('button', { name: 'Sign in' }).click()
    await page.getByRole('heading', { name: 'Your account' }).waitFor()
    await page.goto('/account')
    await page.getByRole('heading', { name: 'Protected account page' }).waitFor()

    await page.goto(proofPath)
    await page.getByText(/invalid, already used, or expired/).waitFor()
    assert.isFalse((await User.findByOrFail('id', user.id)).emailVerifiedAt === null)
  })

  test('reset acknowledgement is generic and reset proof revokes other sessions', async ({
    browser,
    visit,
    assert,
  }) => {
    accountKitNotifications.clear()
    const user = await User.create({
      fullName: 'Morgan Example',
      email: 'morgan@example.test',
      password: 'OldPassword123!',
      emailVerifiedAt: DateTime.now(),
      unverifiedEmail: null,
    })
    const secondContext = await browser.newContext({ baseURL: origin })
    try {
      const requester = await visit('/forgot-password')
      await requester.getByLabel('Email').fill(user.email)
      await requester.getByRole('button', { name: 'Send reset link' }).click()
      await requester
        .getByText('If an account exists for that address, we have sent a reset link.')
        .waitFor()
      const one = await requester.locator('body').innerText()
      const unknown = await secondContext.visit('/forgot-password')
      await unknown.getByLabel('Email').fill('unknown@example.test')
      await unknown.getByRole('button', { name: 'Send reset link' }).click()
      await unknown
        .getByText('If an account exists for that address, we have sent a reset link.')
        .waitFor()
      const two = await unknown.locator('body').innerText()
      assert.equal(one, two)

      const resetToken = accountKitNotifications.tokenFor('passwordResetProvision', user.email)
      const resetPath = `/reset-password/${encodeURIComponent(resetToken)}`
      const oldSession = await secondContext.visit('/login')
      await oldSession.getByLabel('Email').fill(user.email)
      await oldSession.getByLabel('Password').fill('OldPassword123!')
      await oldSession.getByRole('button', { name: 'Sign in' }).click()
      await oldSession.getByRole('heading', { name: 'Your account' }).waitFor()
      await oldSession.goto(resetPath)
      await oldSession.getByRole('heading', { name: 'Choose a new password' }).waitFor()
      await oldSession.goto('/dashboard')
      await oldSession.getByText('Signed in as morgan@example.test.').waitFor()
      await requester.goto(resetPath)
      await requester.getByRole('heading', { name: 'Choose a new password' }).waitFor()
      assert.isNotNull(await User.findByOrFail('id', user.id))
      await requester.getByLabel('New password').fill('NewPassword123!')
      await requester.getByLabel('Confirm password').fill('NewPassword123!')
      await requester.getByRole('button', { name: 'Reset password' }).click()
      await requester.getByRole('heading', { name: 'Sign in' }).waitFor()
      await oldSession.goto('/account')
      await oldSession.getByRole('heading', { name: 'Sign in' }).waitFor()
      await requester.goto(resetPath)
      await requester.getByText(/invalid, already used, or expired/).waitFor()
      assert.isNotNull(await User.verifyCredentials(user.email, 'NewPassword123!'))
    } finally {
      await secondContext.close()
    }
  })
})
