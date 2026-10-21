/* eslint-disable @unicorn/no-await-expression-member -- Keep each browser result beside its assertion. */
import { test } from '@japa/runner'
import User from '#models/user'
import kit from 'adonisjs-account-kit/services/main'
import { setupAccountDatabase } from '../helpers/account_database.js'

type Notifications = {
  accountActivationProvision: (user: unknown, url: string) => Promise<void>
  passwordResetProvision: (user: unknown, url: string) => Promise<void>
  emailChangeProvision: (user: unknown, email: string, url: string) => Promise<void>
}

const notifications = () =>
  (kit as unknown as { deps: { config: { notify: Notifications } } }).deps.config.notify

test.group('composed account browser journeys', (group) => {
  group.each.setup(setupAccountDatabase)

  test('signup, confirm the address, sign in, and log out', async ({ visit, assert }) => {
    const email = 'journey-signup@example.test'
    const notify = notifications()
    const original = notify.accountActivationProvision
    let verificationUrl: string | undefined
    notify.accountActivationProvision = async (_user, url) => {
      verificationUrl = url
    }
    try {
      const page = await visit('/signup')
      await page.goto('/account')
      await page.waitForURL('**/login')
      assert.equal(new URL(page.url()).pathname, '/login')
      await page.goto('/signup')
      await page.getByLabel('Full name').fill('Signup Journey')
      await page.getByLabel('Email').fill(email)
      await page.getByLabel('Password', { exact: true }).fill('SignupPass123!')
      await page.getByLabel('Confirm password').fill('SignupPass123!')
      await page.getByRole('button', { name: 'Create account' }).click()
      await page.getByRole('heading', { name: 'Your dashboard is ready' }).waitFor()
      await page.getByText('Confirm your email address with the link we sent you.').waitFor()
      const pending = await User.findByOrFail('email', email)
      assert.isNull(pending.emailVerifiedAt)
      assert.equal(pending.unverifiedEmail, email)

      // The dashboard is limited access; this real application page requires confirmed email.
      await page.goto('/account')
      assert.equal(new URL(page.url()).pathname, '/dashboard')
      await page.getByText('Confirm your email address before opening this page.').waitFor()
      assert.include(
        await page.locator('body').innerText(),
        'Confirm your email address before opening this page.'
      )
      await page.goto('/settings/email')
      await page.getByText('Confirm your current address before requesting a new one.').waitFor()
      assert.equal(await page.getByRole('button', { name: 'Request change' }).count(), 0)
      assert.isString(verificationUrl)
      await page.goto(new URL(verificationUrl!).pathname)
      await page.getByRole('heading', { name: 'Confirm your email' }).waitFor()
      await page.getByLabel('Password', { exact: true }).fill('ConfirmedPass123!')
      await page.getByLabel('Confirm password').fill('ConfirmedPass123!')
      await page.getByRole('button', { name: 'Confirm email' }).click()
      await page.getByRole('heading', { name: 'Welcome back' }).waitFor()
      assert.isNotNull((await User.findByOrFail('email', email)).emailVerifiedAt)

      await page.getByLabel('Email').fill(email)
      await page.getByLabel('Password').fill('ConfirmedPass123!')
      await page.getByRole('button', { name: 'Sign in' }).click()
      await page.getByRole('heading', { name: 'Your dashboard is ready' }).waitFor()
      const confirmed = await page.goto('/account')
      await page.getByRole('heading', { name: 'Your account is confirmed' }).waitFor()
      assert.equal(confirmed?.status(), 200)
      assert.include(await page.locator('body').innerText(), 'Your account is confirmed')
      await page.goto('/settings/email')
      await page.getByRole('button', { name: 'Request change' }).waitFor()
      await page.getByRole('button', { name: 'Log out' }).click()
      await page.getByRole('heading', { name: 'Welcome back' }).waitFor()
      await page.goto('/account')
      await page.getByRole('heading', { name: 'Welcome back' }).waitFor()
      await page.goto('/settings/email')
      await page.getByRole('heading', { name: 'Welcome back' }).waitFor()
    } finally {
      notify.accountActivationProvision = original
    }
  })

  test('a signed-in reset ends old sessions and rejects proof replay', async ({
    visit,
    browser,
    assert,
  }) => {
    const email = 'journey-reset@example.test'
    const owner = await User.create({ fullName: 'Reset Journey', email, password: 'OldPass123!' })
    const notify = notifications()
    const original = notify.passwordResetProvision
    let resetUrl: string | undefined
    notify.passwordResetProvision = async (_user, url) => {
      resetUrl = url
    }
    const secondContext = await browser.newContext({ baseURL: process.env.APP_URL })
    const guestContext = await browser.newContext({ baseURL: process.env.APP_URL })
    try {
      const current = await visit('/login')
      const previous = await secondContext.visit('/login')
      for (const page of [current, previous]) {
        await page.getByLabel('Email').fill(email)
        await page.getByLabel('Password').fill('OldPass123!')
        await page.getByRole('button', { name: 'Sign in' }).click()
        await page.getByRole('heading', { name: 'Your dashboard is ready' }).waitFor()
      }
      const guest = await guestContext.visit('/forgot-password')
      await guest.getByLabel('Email').fill(email)
      await guest.getByRole('button', { name: 'Send reset link' }).click()
      await guest
        .getByText('If an account exists for that address, we have sent a reset link.')
        .waitFor()
      assert.isString(resetUrl)

      const proofPath = new URL(resetUrl!).pathname
      await current.goto(proofPath)
      await current.getByRole('heading', { name: 'Choose a new password' }).waitFor()
      await current.goto('/settings/profile')
      await current.getByText(email).waitFor()
      await current.goto('/dashboard')
      await current.getByRole('heading', { name: 'Your dashboard is ready' }).waitFor()
      await current.goto(proofPath)
      await current.getByLabel('New password', { exact: true }).fill('ReplacementPass123!')
      await current.getByLabel('Confirm new password').fill('ReplacementPass123!')
      await current.getByRole('button', { name: 'Reset password' }).click()
      await current.getByRole('heading', { name: 'Welcome back' }).waitFor()
      await previous.goto('/dashboard')
      await previous.getByRole('heading', { name: 'Welcome back' }).waitFor()
      await current.goto(proofPath)
      await current.getByRole('heading', { name: 'This link can’t be used' }).waitFor()
      await current.getByRole('link', { name: 'Request a new link' }).waitFor()
      const authenticated = await User.verifyCredentials(email, 'ReplacementPass123!')
      assert.equal(authenticated.id, owner.id)
      await current.goto('/login')
      await current.getByLabel('Email').fill(email)
      await current.getByLabel('Password').fill('ReplacementPass123!')
      await current.getByRole('button', { name: 'Sign in' }).click()
      await current.getByRole('heading', { name: 'Your dashboard is ready' }).waitFor()
    } finally {
      notify.passwordResetProvision = original
      await guestContext.close()
      await secondContext.close()
    }
  })

  test('two sessions manage profile, email proofs, and password renewal', async ({
    visit,
    browser,
    assert,
  }) => {
    const originalEmail = 'journey-settings@example.test'
    const owner = await User.create({
      fullName: 'Settings Journey',
      email: originalEmail,
      password: 'OldPass123!',
    })
    const notify = notifications()
    const original = notify.emailChangeProvision
    const confirmationUrls: string[] = []
    notify.emailChangeProvision = async (_user, _email, url) => {
      confirmationUrls.push(url)
    }
    const secondContext = await browser.newContext({ baseURL: process.env.APP_URL })
    try {
      const ownerPage = await visit('/login')
      const otherPage = await secondContext.visit('/login')
      for (const page of [ownerPage, otherPage]) {
        await page.getByLabel('Email').fill(originalEmail)
        await page.getByLabel('Password').fill('OldPass123!')
        await page.getByRole('button', { name: 'Sign in' }).click()
        await page.getByRole('heading', { name: 'Your dashboard is ready' }).waitFor()
      }

      await ownerPage.goto('/settings/profile')
      await ownerPage.getByLabel('Full name').fill('Updated Settings Journey')
      await ownerPage.getByLabel('Current password').fill('OldPass123!')
      await ownerPage.getByRole('button', { name: 'Save profile' }).click()
      await ownerPage.getByText('Your profile has been updated.').waitFor()
      assert.equal((await User.findOrFail(owner.id)).fullName, 'Updated Settings Journey')

      await ownerPage.goto('/settings/email')
      await ownerPage.getByLabel('New email address').fill('cancelled@example.test')
      await ownerPage.getByLabel('Current password').fill('OldPass123!')
      await ownerPage.getByRole('button', { name: 'Request change' }).click()
      await ownerPage.getByText('Pending confirmation:').waitFor()
      await ownerPage.getByLabel('Current password').last().fill('OldPass123!')
      await ownerPage.getByRole('button', { name: 'Cancel pending change' }).click()
      await ownerPage.getByText('Pending confirmation:').waitFor({ state: 'hidden' })
      await otherPage.goto(new URL(confirmationUrls[0]).pathname)
      await otherPage.getByRole('heading', { name: 'This link can’t be used' }).waitFor()
      await otherPage.goto('/dashboard')
      await otherPage.getByRole('heading', { name: 'Your dashboard is ready' }).waitFor()

      await ownerPage.getByLabel('New email address').fill('renewed@example.test')
      await ownerPage.getByLabel('Current password').fill('OldPass123!')
      await ownerPage.getByRole('button', { name: 'Request change' }).click()
      await ownerPage.getByText('Pending confirmation:').waitFor()
      assert.equal((await User.findOrFail(owner.id)).email, originalEmail)
      await otherPage.goto(new URL(confirmationUrls[1]).pathname)
      await otherPage.getByRole('heading', { name: 'Confirm your new email' }).waitFor()
      await otherPage.goto('/settings/profile')
      await otherPage.getByText(originalEmail).waitFor()
      await otherPage.goto('/dashboard')
      await otherPage.getByRole('heading', { name: 'Your dashboard is ready' }).waitFor()
      await otherPage.goto(new URL(confirmationUrls[1]).pathname)
      await otherPage.getByRole('button', { name: 'Confirm email change' }).click()
      await otherPage.getByRole('heading', { name: 'Welcome back' }).waitFor()
      assert.equal((await User.findOrFail(owner.id)).email, 'renewed@example.test')
      await ownerPage.goto('/dashboard')
      await ownerPage.getByRole('heading', { name: 'Welcome back' }).waitFor()

      for (const page of [ownerPage, otherPage]) {
        await page.goto('/login')
        await page.getByLabel('Email').fill('renewed@example.test')
        await page.getByLabel('Password').fill('OldPass123!')
        await page.getByRole('button', { name: 'Sign in' }).click()
        await page.getByRole('heading', { name: 'Your dashboard is ready' }).waitFor()
      }
      await ownerPage.goto('/settings/password')
      await ownerPage.getByLabel('Current password').fill('OldPass123!')
      await ownerPage.getByLabel('New password', { exact: true }).fill('NewestPass123!')
      await ownerPage.getByLabel('Confirm new password').fill('NewestPass123!')
      await ownerPage.getByRole('button', { name: 'Change password' }).click()
      await ownerPage.getByText('Password changed. Other devices have been signed out.').waitFor()
      await ownerPage.goto('/dashboard')
      await ownerPage.getByRole('heading', { name: 'Your dashboard is ready' }).waitFor()
      await ownerPage.goto('/settings/profile')
      await ownerPage.getByText('renewed@example.test').waitFor()
      await otherPage.goto('/dashboard')
      await otherPage.getByRole('heading', { name: 'Welcome back' }).waitFor()
      assert.equal(
        (await User.verifyCredentials('renewed@example.test', 'NewestPass123!')).id,
        owner.id
      )
    } finally {
      notify.emailChangeProvision = original
      await secondContext.close()
    }
  })
})
