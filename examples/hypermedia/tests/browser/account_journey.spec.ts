/* eslint-disable @unicorn/no-await-expression-member -- Each browser action is asserted beside the state it produces. */

import { test } from '@japa/runner'
import { DateTime } from 'luxon'
import { createHash, randomBytes } from 'node:crypto'
import db from '@adonisjs/lucid/services/db'
import limiter from '@adonisjs/limiter/services/main'
import { Session } from '@adonisjs/session'
import User from '#models/user'
import { accountKitNotifications } from '#services/account_kit_notifications'
import { setupAccountDatabase } from '#tests/helpers/account_database'
import { errors } from '@kevinjohn/adonisjs-account-kit'
import kit from '@kevinjohn/adonisjs-account-kit/services/main'

const origin = process.env.APP_URL!

test.group('native account journeys', (group) => {
  group.each.setup(async () => {
    const cleanup = await setupAccountDatabase()
    await limiter.clear(['memory'])
    return cleanup
  })

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

  test('new unverified accounts can confirm their password for profile and password changes', async ({
    visit,
    assert,
  }) => {
    const page = await visit('/signup')
    await page.getByLabel('Full name').fill('Unverified Example')
    await page.getByLabel('Email').fill('unverified-settings@example.test')
    await page.getByLabel('Password', { exact: true }).fill('SignupPass123!')
    await page.getByLabel('Confirm password').fill('SignupPass123!')
    await page.getByRole('button', { name: 'Create account' }).click()
    await page.getByRole('heading', { name: 'Your account' }).waitFor()
    const user = await User.findByOrFail('email', 'unverified-settings@example.test')
    assert.isNull(user.emailVerifiedAt)
    assert.equal(user.unverifiedEmail, user.email)

    await page.goto('/settings/profile')
    await page.getByLabel('Full name').fill('Updated Unverified Example')
    await page.getByLabel('Current password').fill('SignupPass123!')
    await page.getByRole('button', { name: 'Save profile' }).click()
    await page.getByText('Your profile has been updated.').waitFor()
    assert.notInclude(await page.locator('body').innerText(), 'Your current password is incorrect.')
    assert.equal((await User.findByOrFail('id', user.id)).fullName, 'Updated Unverified Example')

    await page.goto('/settings/password')
    await page.getByLabel('Current password').fill('SignupPass123!')
    await page.getByLabel('New password', { exact: true }).fill('ChangedPass123!')
    await page.getByLabel('Confirm new password').fill('ChangedPass123!')
    await page.getByRole('button', { name: 'Change password' }).click()
    await page.getByText('Password changed. Other sessions have been signed out.').waitFor()
    assert.notInclude(await page.locator('body').innerText(), 'Your current password is incorrect.')
    assert.equal((await User.verifyCredentials(user.email, 'ChangedPass123!')).id, user.id)
    const unchanged = await User.findByOrFail('id', user.id)
    assert.isNull(unchanged.emailVerifiedAt)
    assert.equal(unchanged.unverifiedEmail, user.email)
    await page.goto('/account')
    await page.getByRole('heading', { name: 'Your account' }).waitFor()
    assert.equal(new URL(page.url()).pathname, '/dashboard')
  })

  test('validation retains safe fields, clears secrets, and focuses an error', async ({
    visit,
    assert,
  }) => {
    const page = await visit('/signup')
    await page.getByLabel('Full name').fill('Taylor Example')
    await page.getByLabel('Email').fill('taylor@example.test')
    await page.getByLabel('Password', { exact: true }).fill('SignupPass123!')
    await page.getByLabel('Confirm password').fill('different-password')
    const sessionPrototype = Session.prototype as unknown as {
      flash: (this: Session, key: string, value: unknown) => void
    }
    const originalFlash = sessionPrototype.flash
    let flashedInput: unknown
    sessionPrototype.flash = function (key, value) {
      if (key === 'input') flashedInput = value
      return originalFlash.call(this, key, value)
    }
    const postResponse = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' && new URL(response.url()).pathname === '/signup'
    )
    try {
      await page.getByRole('button', { name: 'Create account' }).click()
      await postResponse
    } finally {
      sessionPrototype.flash = originalFlash
    }
    const oldInput = JSON.stringify(flashedInput)
    assert.include(oldInput, 'Taylor Example')
    assert.include(oldInput, 'taylor@example.test')
    assert.notInclude(oldInput, 'SignupPass123!')
    assert.notInclude(oldInput, 'different-password')
    await page.getByText('Confirm password must match Password.').waitFor()

    assert.equal(await page.getByLabel('Full name').inputValue(), 'Taylor Example')
    assert.equal(await page.getByLabel('Email').inputValue(), 'taylor@example.test')
    assert.equal(await page.getByLabel('Password', { exact: true }).inputValue(), '')
    assert.equal(await page.getByLabel('Confirm password').inputValue(), '')
    assert.equal(await page.locator(':focus').getAttribute('name'), 'passwordConfirmation')
    await page.setViewportSize({ width: 375, height: 812 })
    const narrowForm = await page.locator('form').boundingBox()
    const narrowSubmit = await page.getByRole('button', { name: 'Create account' }).boundingBox()
    assert.isNotNull(narrowForm)
    assert.isNotNull(narrowSubmit)
    assert.isAtLeast(narrowForm!.x, 0)
    assert.isAtMost(narrowForm!.x + narrowForm!.width, 375)
    assert.isAtMost(narrowSubmit!.x + narrowSubmit!.width, 375)
    await page.keyboard.press('Tab')
    assert.equal(await page.locator(':focus').getAttribute('type'), 'submit')
    await page.locator('input[name="_csrf"]').waitFor({ state: 'attached' })
    // Read what each session is about to store, whichever Session method wrote it.
    const committing = Session.prototype as unknown as { commit: (this: Session) => Promise<void> }
    const originalCommit = committing.commit
    const csrfFlashes: string[] = []
    committing.commit = function () {
      csrfFlashes.push(JSON.stringify(this.responseFlashMessages.all()))
      return originalCommit.call(this)
    }
    let invalidCsrf: Awaited<ReturnType<typeof page.request.post>>
    try {
      invalidCsrf = await page.request.post(`${origin}/signup`, {
        data: {
          fullName: 'No CSRF',
          email: 'no-csrf@example.test',
          password: 'SignupPass123!',
          passwordConfirmation: 'SignupPass123!',
        },
        maxRedirects: 0,
      })
    } finally {
      committing.commit = originalCommit
    }
    assert.include(csrfFlashes.join(), 'no-csrf@example.test')
    assert.notInclude(csrfFlashes.join(), 'SignupPass123!')
    assert.equal(invalidCsrf.status(), 302)
    assert.equal(invalidCsrf.headers().location, '/')
    assert.isNull(await User.findBy('email', 'no-csrf@example.test'))

    await page.goto('/login')
    await page.getByLabel('Email').fill('unknown@example.test')
    await page.getByLabel('Password').fill('UnknownPass123!')
    await page.getByRole('button', { name: 'Sign in' }).click()
    await page
      .getByText('The email or password is incorrect. Check your details and try again.')
      .waitFor()
    assert.equal(await page.getByLabel('Email').inputValue(), 'unknown@example.test')
    assert.equal(await page.getByLabel('Password').inputValue(), '')
  })

  test('throttled signup and reset requests answer with a page, not JSON', async ({
    browser,
    assert,
  }) => {
    const context = await browser.newContext({ baseURL: origin, javaScriptEnabled: false })
    const throttled = 'Too many attempts. Wait a few minutes and try again.'
    try {
      const page = await context.visit('/forgot-password')
      for (let attempt = 0; attempt < 6; attempt++) {
        await page.getByLabel('Email').fill('unknown@example.test')
        await page.getByRole('button', { name: 'Send reset link' }).click()
        await page.getByRole('heading', { name: 'Reset your password' }).waitFor()
      }
      assert.include(await page.locator('body').innerText(), throttled)

      // Each signup attempt spends the client budget before validation runs.
      await page.goto('/signup')
      for (let attempt = 0; attempt < 6; attempt++) {
        await page.getByLabel('Full name').fill('Taylor Example')
        await page.getByLabel('Email').fill('throttled@example.test')
        await page.getByLabel('Password', { exact: true }).fill('SignupPass123!')
        await page.getByLabel('Confirm password').fill('DifferentPass123!')
        await page.getByRole('button', { name: 'Create account' }).click()
        await page.getByRole('button', { name: 'Create account' }).waitFor()
      }
      assert.include(await page.locator('body').innerText(), throttled)
    } finally {
      await context.close()
    }
  })

  test('failure and recovery feedback work without JavaScript and errors persist with JavaScript', async ({
    browser,
    visit,
    assert,
  }) => {
    const context = await browser.newContext({ baseURL: origin, javaScriptEnabled: false })
    const errorMessage = 'The email or password is incorrect. Check your details and try again.'
    const resetMessage = 'If an account exists for that address, we have sent a reset link.'

    try {
      const page = await context.visit('/login')
      await page.getByLabel('Email').fill('unknown@example.test')
      await page.getByLabel('Password').fill('UnknownPass123!')
      await page.getByRole('button', { name: 'Sign in' }).click()
      await page.getByText(errorMessage).waitFor()
      assert.isTrue(await page.getByText(errorMessage).isVisible())
      await page.getByRole('link', { name: 'Forgot your password?' }).click()
      await page.getByRole('heading', { name: 'Reset your password' }).waitFor()
      await page.getByLabel('Email').fill('unknown@example.test')
      await page.getByRole('button', { name: 'Send reset link' }).click()
      const resetFeedback = await page.locator('body').innerText()
      assert.include(resetFeedback, resetMessage, `Unexpected reset response at ${page.url()}`)
      assert.isTrue(await page.getByText(resetMessage).isVisible())
    } finally {
      await context.close()
    }

    const javascriptPage = await visit('/login')
    await javascriptPage.clock.install()
    await javascriptPage.getByLabel('Email').fill('unknown@example.test')
    await javascriptPage.getByLabel('Password').fill('UnknownPass123!')
    await javascriptPage.getByRole('button', { name: 'Sign in' }).click()
    const javascriptError = javascriptPage.getByText(errorMessage)
    await javascriptError.waitFor()
    await javascriptPage.waitForLoadState('load')
    const readyThemeToggle = javascriptPage.getByRole('button', {
      name: /^Switch to (light|dark) theme$/,
    })
    await readyThemeToggle.waitFor({ state: 'visible' })
    assert.isNull(await readyThemeToggle.getAttribute('x-cloak'))
    // Advance dismissal timers only after the returned document has initialized Alpine.
    await javascriptPage.clock.fastForward(60_000)
    assert.isTrue(await javascriptError.isVisible())
  })

  test('separate profile, email, and password owners follow session and logout policy', async ({
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
    const emailOwner = await User.create({
      fullName: 'Email Owner',
      email: 'email-owner@example.test',
      password: 'EmailOwnerPassword123!',
      emailVerifiedAt: DateTime.now(),
      unverifiedEmail: null,
    })
    const passwordOwner = await User.create({
      fullName: 'Password Owner',
      email: 'password-owner@example.test',
      password: 'PasswordOwnerPassword123!',
      emailVerifiedAt: DateTime.now(),
      unverifiedEmail: null,
    })
    const contexts: Array<{ close: () => Promise<void> }> = []
    let testFailed = false
    let testFailure: unknown
    try {
      const otherContext = await browser.newContext({ baseURL: origin })
      contexts.push(otherContext)
      const emailContext = await browser.newContext({ baseURL: origin })
      contexts.push(emailContext)
      const primary = await visit('/login')
      await primary.getByLabel('Email').fill(user.email)
      await primary.getByLabel('Password').fill('OldPassword123!')
      await primary.getByRole('button', { name: 'Sign in' }).click()
      await primary.getByRole('heading', { name: 'Your account' }).waitFor()

      const otherSession = await otherContext.visit('/login')
      await otherSession.getByLabel('Email').fill(emailOwner.email)
      await otherSession.getByLabel('Password').fill('EmailOwnerPassword123!')
      await otherSession.getByRole('button', { name: 'Sign in' }).click()
      await otherSession.getByRole('heading', { name: 'Your account' }).waitFor()
      const emailPrimary = await emailContext.visit('/login')
      await emailPrimary.getByLabel('Email').fill(emailOwner.email)
      await emailPrimary.getByLabel('Password').fill('EmailOwnerPassword123!')
      await emailPrimary.getByRole('button', { name: 'Sign in' }).click()
      await emailPrimary.getByRole('heading', { name: 'Your account' }).waitFor()

      await primary.goto('/settings/profile')
      assert.equal(await primary.getByLabel('Full name').inputValue(), 'Morgan Example')
      const csrf = await primary
        .locator('form')
        .filter({ has: primary.getByRole('button', { name: 'Save profile', exact: true }) })
        .locator('input[name="_csrf"]')
        .inputValue()
      const validation = await primary.request.post(`${origin}/settings/profile`, {
        form: { _csrf: csrf, fullName: '', currentPassword: '' },
        headers: { referer: `${origin}/settings/profile` },
        maxRedirects: 0,
      })
      assert.equal(validation.status(), 302)
      await primary.goto('/settings/profile')
      await primary.locator('#currentPassword-error').waitFor()
      assert.equal(
        await primary.getByLabel('Current password').getAttribute('aria-invalid'),
        'true'
      )
      assert.equal(await primary.getByLabel('Full name').inputValue(), '')
      assert.equal((await User.findByOrFail('id', user.id)).fullName, 'Morgan Example')
      await primary.goto('/settings/profile')
      assert.equal(await primary.getByLabel('Full name').inputValue(), 'Morgan Example')
      await primary.getByLabel('Full name').fill('  Morgan Updated  ')
      await primary.getByLabel('Current password').fill('wrong-password')
      await primary.getByRole('button', { name: 'Save profile' }).click()
      await primary
        .getByText('Your current password is incorrect. Check it and try again.')
        .waitFor()
      assert.equal(await primary.getByLabel('Full name').inputValue(), 'Morgan Updated')
      assert.equal(await primary.getByLabel('Current password').inputValue(), '')
      await primary.getByLabel('Current password').fill('OldPassword123!')
      await primary.getByRole('button', { name: 'Save profile' }).click()
      await primary.getByText('Your profile has been updated.').waitFor()
      assert.equal((await User.findByOrFail('id', user.id)).fullName, 'Morgan Updated')
      await primary.getByLabel('Full name').fill('')
      await primary.getByLabel('Current password').fill('wrong-password')
      await primary.getByRole('button', { name: 'Save profile' }).click()
      await primary
        .getByText('Your current password is incorrect. Check it and try again.')
        .waitFor()
      assert.equal(await primary.getByLabel('Full name').inputValue(), '')
      assert.equal(await primary.getByLabel('Current password').inputValue(), '')
      assert.equal((await User.findByOrFail('id', user.id)).fullName, 'Morgan Updated')
      await primary.getByLabel('Current password').fill('OldPassword123!')
      await primary.getByRole('button', { name: 'Save profile' }).click()
      await primary.getByText('Your profile has been updated.').waitFor()
      assert.isNull((await User.findByOrFail('id', user.id)).fullName)

      const existing = await User.create({
        fullName: 'Existing Example',
        email: 'existing@example.test',
        password: 'OtherPassword123!',
        emailVerifiedAt: DateTime.now(),
        unverifiedEmail: null,
      })
      await emailPrimary.goto('/settings/email')
      await emailPrimary.getByLabel('New email').fill(existing.email)
      await emailPrimary.getByLabel('Current password').fill('EmailOwnerPassword123!')
      await emailPrimary.getByRole('button', { name: 'Request email change' }).click()
      await emailPrimary.getByText('This address cannot be used. Try another address.').waitFor()
      assert.equal(await emailPrimary.getByLabel('New email').inputValue(), existing.email)
      await emailPrimary.getByLabel('New email').fill('email-owner.new@example.test')
      await emailPrimary.getByLabel('Current password').fill('wrong-password')
      await emailPrimary.getByRole('button', { name: 'Request email change' }).click()
      await emailPrimary
        .getByText('Your current password is incorrect. Check it and try again.')
        .waitFor()
      assert.equal(
        await emailPrimary.getByLabel('New email').inputValue(),
        'email-owner.new@example.test'
      )
      assert.equal(await emailPrimary.getByLabel('Current password').inputValue(), '')
      await emailPrimary.getByLabel('Current password').fill('EmailOwnerPassword123!')
      await emailPrimary.getByRole('button', { name: 'Request email change' }).click()
      await emailPrimary.getByText(/Your current email stays active until you confirm it/).waitFor()
      assert.equal((await User.findByOrFail('id', emailOwner.id)).email, emailOwner.email)

      await emailPrimary.goto('/settings/email')
      await emailPrimary.getByLabel('Current password').fill('EmailOwnerPassword123!')
      await emailPrimary.getByRole('button', { name: 'Cancel pending change' }).click()
      await emailPrimary.getByText('The pending email change was canceled.').waitFor()
      assert.isNull((await User.findByOrFail('id', emailOwner.id)).unverifiedEmail)

      await emailPrimary.goto('/settings/email')
      await emailPrimary.getByLabel('New email').fill('email-owner.new@example.test')
      await emailPrimary.getByLabel('Current password').fill('EmailOwnerPassword123!')
      await emailPrimary.getByRole('button', { name: 'Request email change' }).click()
      await emailPrimary.getByText(/Your current email stays active until you confirm it/).waitFor()
      const emailToken = accountKitNotifications.tokenFor(
        'emailChangeProvision',
        'email-owner.new@example.test'
      )
      const emailProof = `/confirm-email/${encodeURIComponent(emailToken)}`
      const visitor = await User.create({
        fullName: 'Independent Visitor',
        email: 'visitor@example.test',
        password: 'VisitorPassword123!',
        emailVerifiedAt: DateTime.now(),
        unverifiedEmail: null,
      })
      const visitorContext = await browser.newContext({ baseURL: origin })
      contexts.push(visitorContext)
      const inspection = await visitorContext.visit('/login')
      await inspection.getByLabel('Email').fill(visitor.email)
      await inspection.getByLabel('Password').fill('VisitorPassword123!')
      await inspection.getByRole('button', { name: 'Sign in' }).click()
      await inspection.getByRole('heading', { name: 'Your account' }).waitFor()
      await inspection.goto(`${origin}${emailProof}`)
      await inspection.getByRole('heading', { name: 'Confirm your new email' }).waitFor()
      await otherSession.goto('/dashboard')
      await otherSession.getByText('Signed in as email-owner@example.test.').waitFor()
      await inspection.goto(`${origin}${emailProof}`)
      await inspection.getByRole('button', { name: 'Confirm email change' }).click()
      await inspection.getByText('Welcome to the power of a Hypermedia app.').waitFor()
      await inspection.goto('/dashboard')
      await inspection.getByRole('heading', { name: 'Your account' }).waitFor()
      await inspection.getByText('Signed in as visitor@example.test.').waitFor()
      await inspection.goto('/account')
      await inspection.getByRole('heading', { name: 'Protected account page' }).waitFor()
      assert.equal(
        (await User.findByOrFail('id', emailOwner.id)).email,
        'email-owner.new@example.test'
      )
      await otherSession.goto('/account')
      await otherSession.getByRole('heading', { name: 'Sign in' }).waitFor()
      await emailPrimary.goto('/account')
      await emailPrimary.getByRole('heading', { name: 'Sign in' }).waitFor()

      const passwordContext = await browser.newContext({ baseURL: origin })
      contexts.push(passwordContext)
      const otherPasswordSession = await passwordContext.visit('/login')
      await otherPasswordSession.getByLabel('Email').fill(passwordOwner.email)
      await otherPasswordSession.getByLabel('Password').fill('PasswordOwnerPassword123!')
      await otherPasswordSession.getByRole('button', { name: 'Sign in' }).click()
      await otherPasswordSession.getByRole('heading', { name: 'Your account' }).waitFor()

      const passwordPrimaryContext = await browser.newContext({ baseURL: origin })
      contexts.push(passwordPrimaryContext)
      const passwordPrimary = await passwordPrimaryContext.visit('/login')
      await passwordPrimary.getByLabel('Email').fill(passwordOwner.email)
      await passwordPrimary.getByLabel('Password').fill('PasswordOwnerPassword123!')
      await passwordPrimary.getByRole('button', { name: 'Sign in' }).click()
      await passwordPrimary.getByRole('heading', { name: 'Your account' }).waitFor()
      await passwordPrimary.goto('/settings/password')
      await passwordPrimary.getByLabel('Current password').fill('wrong-password')
      await passwordPrimary.getByLabel('New password', { exact: true }).fill('NewPassword123!')
      await passwordPrimary.getByLabel('Confirm new password').fill('NewPassword123!')
      await passwordPrimary.getByRole('button', { name: 'Change password' }).click()
      await passwordPrimary
        .getByText('Your current password is incorrect. Check it and try again.')
        .waitFor()
      assert.equal(await passwordPrimary.getByLabel('Current password').inputValue(), '')
      await passwordPrimary.getByLabel('Current password').fill('PasswordOwnerPassword123!')
      await passwordPrimary.getByLabel('New password', { exact: true }).fill('NewPassword123!')
      await passwordPrimary.getByLabel('Confirm new password').fill('NewPassword123!')
      await passwordPrimary.getByRole('button', { name: 'Change password' }).click()
      await passwordPrimary
        .getByText('Password changed. Other sessions have been signed out.')
        .waitFor()
      assert.isNotNull(await User.verifyCredentials(passwordOwner.email, 'NewPassword123!'))
      await otherPasswordSession.goto('/account')
      await otherPasswordSession.getByRole('heading', { name: 'Sign in' }).waitFor()
      const newEmailContext = await browser.newContext({ baseURL: origin })
      contexts.push(newEmailContext)
      const newEmailLogin = await newEmailContext.visit('/login')
      await newEmailLogin.getByLabel('Email').fill('email-owner.new@example.test')
      await newEmailLogin.getByLabel('Password').fill('EmailOwnerPassword123!')
      await newEmailLogin.getByRole('button', { name: 'Sign in' }).click()
      await newEmailLogin.getByRole('heading', { name: 'Your account' }).waitFor()
      const savedSessionCookie = (await passwordPrimary.context().cookies()).find(
        (cookie) => cookie.name === 'adonis-session'
      )
      assert.isDefined(savedSessionCookie)
      const replayContext = await browser.newContext({ baseURL: origin })
      contexts.push(replayContext)
      await replayContext.addCookies([savedSessionCookie!])
      await passwordPrimary.getByRole('button', { name: 'Log out' }).click()
      await passwordPrimary.getByRole('heading', { name: 'Sign in' }).waitFor()
      assert.equal(new URL(passwordPrimary.url()).pathname, '/login')
      const replay = await replayContext.visit('/account')
      await replay.getByRole('heading', { name: 'Sign in' }).waitFor()
    } catch (error) {
      testFailed = true
      testFailure = error
    }
    const cleanupFailures: unknown[] = []
    for (const context of contexts) {
      try {
        await context.close()
      } catch (error) {
        cleanupFailures.push(error)
      }
    }
    if (cleanupFailures.length > 0) {
      throw new AggregateError(
        testFailed ? [testFailure, ...cleanupFailures] : cleanupFailures,
        'Failed to close all profile journey browser contexts'
      )
    }
    if (testFailed) throw testFailure
  })

  test('signed-in visitors keep their identity while inspecting another account proof', async ({
    visit,
    assert,
  }) => {
    accountKitNotifications.clear()
    const proofOwner = await User.create({
      fullName: 'Proof Owner',
      email: 'owner@example.test',
      password: 'OwnerPassword123!',
      emailVerifiedAt: null,
      unverifiedEmail: 'owner@example.test',
    })
    await kit.emailVerification.send({ userId: proofOwner.id })
    const proof = accountKitNotifications.tokenFor('accountActivationProvision', proofOwner.email)
    const visitor = await User.create({
      fullName: 'Signed In Visitor',
      email: 'visitor@example.test',
      password: 'VisitorPassword123!',
      emailVerifiedAt: DateTime.now(),
      unverifiedEmail: null,
    })
    const page = await visit('/login')
    await page.getByLabel('Email').fill(visitor.email)
    await page.getByLabel('Password').fill('VisitorPassword123!')
    await page.getByRole('button', { name: 'Sign in' }).click()
    await page.getByRole('heading', { name: 'Your account' }).waitFor()
    await page.goto(`/verify-email/${encodeURIComponent(proof)}`)
    await page.getByRole('heading', { name: 'Confirm your email' }).waitFor()
    await page.goto('/dashboard')
    await page.getByText('Signed in as visitor@example.test.').waitFor()
    assert.equal((await User.findByOrFail('id', proofOwner.id)).emailVerifiedAt, null)
  })

  test('committed signup survives notification failure and can be recovered by resend', async ({
    visit,
    assert,
  }) => {
    accountKitNotifications.clear()
    const notify = accountKitNotifications.notify.accountActivationProvision
    accountKitNotifications.notify.accountActivationProvision = async () => {
      throw new errors.DeliveryError('test delivery failure')
    }
    try {
      const page = await visit('/signup')
      await page.getByLabel('Full name').fill('Recovery Example')
      await page.getByLabel('Email').fill('recovery@example.test')
      await page.getByLabel('Password', { exact: true }).fill('RecoveryPass123!')
      await page.getByLabel('Confirm password').fill('RecoveryPass123!')
      await page.getByRole('button', { name: 'Create account' }).click()
      await page
        .getByText(/account was created, but we could not confirm the verification email/)
        .waitFor()
      const user = await User.findByOrFail('email', 'recovery@example.test')
      assert.isNotNull(user)
      assert.isNull(user.emailVerifiedAt)
      await db
        .from('email_verification_tokens')
        .where('tokenable_id', user.id)
        .update({ created_at: DateTime.now().minus({ minutes: 2 }).toSQL() })
      accountKitNotifications.notify.accountActivationProvision = notify
      await page.getByRole('button', { name: 'Send a fresh verification link' }).click()
      await page.getByText(/A verification link is on its way/).waitFor()
      const token = accountKitNotifications.tokenFor('accountActivationProvision', user.email)
      await page.goto(`/verify-email/${encodeURIComponent(token)}`)
      await page.getByLabel('Choose a password').fill('RecoveryPass123!')
      await page.getByLabel('Confirm password').fill('RecoveryPass123!')
      await page.getByRole('button', { name: 'Confirm email' }).click()
      await page.getByRole('heading', { name: 'Sign in' }).waitFor()
      assert.isNotNull((await User.findByOrFail('id', user.id)).emailVerifiedAt)
    } finally {
      accountKitNotifications.notify.accountActivationProvision = notify
    }
  })

  test('committed password change survives notification failure and keeps this session', async ({
    visit,
    assert,
  }) => {
    const user = await User.create({
      fullName: 'Notice Example',
      email: 'notice@example.test',
      password: 'OldPassword123!',
      emailVerifiedAt: DateTime.now(),
      unverifiedEmail: null,
    })
    const notify = accountKitNotifications.notify.passwordChanged
    accountKitNotifications.notify.passwordChanged = async () => {
      throw new errors.DeliveryError('test delivery failure')
    }
    try {
      const page = await visit('/login')
      await page.getByLabel('Email').fill(user.email)
      await page.getByLabel('Password').fill('OldPassword123!')
      await page.getByRole('button', { name: 'Sign in' }).click()
      await page.getByRole('heading', { name: 'Your account' }).waitFor()
      await page.goto('/settings/password')
      await page.getByLabel('Current password').fill('OldPassword123!')
      await page.getByLabel('New password', { exact: true }).fill('NewPassword123!')
      await page.getByLabel('Confirm new password').fill('NewPassword123!')
      await page.getByRole('button', { name: 'Change password' }).click()
      await page
        .getByText(
          'Password changed. Other sessions have been signed out. We could not send the confirmation email.'
        )
        .waitFor()
      assert.isNotNull(await User.verifyCredentials(user.email, 'NewPassword123!'))
      await page.goto('/account')
      await page.getByRole('heading', { name: 'Protected account page' }).waitFor()
    } finally {
      accountKitNotifications.notify.passwordChanged = notify
    }
  })

  test('expired verification proof is rejected separately from replay', async ({
    visit,
    assert,
  }) => {
    const user = await User.create({
      fullName: 'Expired Proof',
      email: 'expired@example.test',
      password: 'ExpiredPass123!',
      emailVerifiedAt: null,
      unverifiedEmail: 'expired@example.test',
    })
    // A well-formed token, so only its expiry can refuse it.
    const token = randomBytes(32).toString('base64url')
    const hash = createHash('sha256').update(token).digest('hex')
    await db.table('email_verification_tokens').insert({
      tokenable_id: user.id,
      email: user.email,
      current_email: user.email,
      purpose: 'activation',
      hash,
      expires_at: DateTime.utc().minus({ minutes: 1 }).toISO(),
      created_at: DateTime.utc().minus({ minutes: 2 }).toISO(),
    })
    const page = await visit(`/verify-email/${encodeURIComponent(token)}`)
    await page.getByText(/This link is invalid, already used, or expired/).waitFor()
    assert.isNull((await User.findByOrFail('id', user.id)).emailVerifiedAt)
    // The same row with a future expiry is accepted.
    await db
      .from('email_verification_tokens')
      .where('hash', hash)
      .update({ expires_at: DateTime.utc().plus({ hours: 1 }).toISO() })
    await page.goto(`/verify-email/${encodeURIComponent(token)}`)
    await page.getByRole('button', { name: 'Confirm email' }).waitFor()
  })

  test('a confirmed account signs in without the confirmation reminder', async ({ visit }) => {
    const user = await User.create({
      fullName: 'Confirmed Example',
      email: 'confirmed@example.test',
      password: 'ConfirmedPass123!',
      emailVerifiedAt: DateTime.now(),
      unverifiedEmail: null,
    })
    const page = await visit('/login')
    await page.getByLabel('Email').fill(user.email)
    await page.getByLabel('Password').fill('ConfirmedPass123!')
    await page.getByRole('button', { name: 'Sign in' }).click()
    await page.getByText('You are signed in.', { exact: true }).waitFor()
  })
})
