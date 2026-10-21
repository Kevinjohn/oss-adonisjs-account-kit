/* eslint-disable @unicorn/no-await-expression-member -- Each browser action is asserted beside the state it produces. */

import { test } from '@japa/runner'
import { DateTime } from 'luxon'
import { createHash } from 'node:crypto'
import app from '@adonisjs/core/services/app'
import db from '@adonisjs/lucid/services/db'
import { SessionCollection } from '@adonisjs/session'
import User from '#models/user'
import { accountKitNotifications } from '#services/account_kit_notifications'
import { setupAccountDatabase } from '#tests/helpers/account_database'
import { errors } from 'adonisjs-account-kit'
import kit from 'adonisjs-account-kit/services/main'

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

  test('validation retains safe fields, clears secrets, and focuses an error', async ({
    visit,
    assert,
  }) => {
    const page = await visit('/signup')
    await page.getByLabel('Full name').fill('Taylor Example')
    await page.getByLabel('Email').fill('taylor@example.test')
    await page.getByLabel('Password', { exact: true }).fill('SignupPass123!')
    await page.getByLabel('Confirm password').fill('different-password')
    const postResponse = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' && new URL(response.url()).pathname === '/signup'
    )
    await page.getByRole('button', { name: 'Create account' }).click()
    await postResponse
    const sessionId = (await page.context().cookies()).find(
      (cookie) => cookie.name === 'adonis-session'
    )?.value
    assert.isString(sessionId)
    const sessions = await app.container.make(SessionCollection)
    const oldInput = JSON.stringify(await sessions.get(sessionId!))
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
    await page.locator('input[name="_csrf"]').waitFor()
    const invalidCsrf = await page.request.post(`${origin}/signup`, {
      data: {
        fullName: 'No CSRF',
        email: 'no-csrf@example.test',
        password: 'SignupPass123!',
        passwordConfirmation: 'SignupPass123!',
      },
      maxRedirects: 0,
    })
    assert.equal(invalidCsrf.status(), 403)
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

  test('profile, email change, password change, and logout follow session policy', async ({
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
    const otherContext = await browser.newContext({ baseURL: origin })
    try {
      const primary = await visit('/login')
      await primary.getByLabel('Email').fill(user.email)
      await primary.getByLabel('Password').fill('OldPassword123!')
      await primary.getByRole('button', { name: 'Sign in' }).click()
      await primary.getByRole('heading', { name: 'Your account' }).waitFor()

      const otherSession = await otherContext.visit('/login')
      await otherSession.getByLabel('Email').fill(user.email)
      await otherSession.getByLabel('Password').fill('OldPassword123!')
      await otherSession.getByRole('button', { name: 'Sign in' }).click()
      await otherSession.getByRole('heading', { name: 'Your account' }).waitFor()

      await primary.goto('/settings/profile')
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

      const existing = await User.create({
        fullName: 'Existing Example',
        email: 'existing@example.test',
        password: 'OtherPassword123!',
        emailVerifiedAt: DateTime.now(),
        unverifiedEmail: null,
      })
      await primary.goto('/settings/email')
      await primary.getByLabel('New email').fill(existing.email)
      await primary.getByLabel('Current password').fill('OldPassword123!')
      await primary.getByRole('button', { name: 'Request email change' }).click()
      await primary.getByText('This address cannot be used. Try another address.').waitFor()
      assert.equal(await primary.getByLabel('New email').inputValue(), existing.email)
      await primary.getByLabel('New email').fill('morgan.new@example.test')
      await primary.getByLabel('Current password').fill('OldPassword123!')
      await primary.getByRole('button', { name: 'Request email change' }).click()
      await primary.getByText(/Your current email stays active until you confirm it/).waitFor()
      assert.equal((await User.findByOrFail('id', user.id)).email, user.email)

      await primary.goto('/settings/email')
      await primary.getByLabel('Current password').fill('OldPassword123!')
      await primary.getByRole('button', { name: 'Cancel pending change' }).click()
      await primary.getByText('The pending email change was canceled.').waitFor()
      assert.equal((await User.findByOrFail('id', user.id)).unverifiedEmail, user.email)

      await primary.goto('/settings/email')
      await primary.getByLabel('New email').fill('morgan.new@example.test')
      await primary.getByLabel('Current password').fill('OldPassword123!')
      await primary.getByRole('button', { name: 'Request email change' }).click()
      await primary.getByText(/Your current email stays active until you confirm it/).waitFor()
      const emailToken = accountKitNotifications.tokenFor(
        'emailChangeProvision',
        'morgan.new@example.test'
      )
      const emailProof = `/confirm-email/${encodeURIComponent(emailToken)}`
      const inspection = await otherContext.newPage()
      await inspection.goto(`${origin}${emailProof}`)
      await inspection.getByRole('heading', { name: 'Confirm your new email' }).waitFor()
      await otherSession.goto('/dashboard')
      await otherSession.getByText('Signed in as morgan@example.test.').waitFor()
      await inspection.goto(`${origin}${emailProof}`)
      await inspection.getByRole('button', { name: 'Confirm email change' }).click()
      await inspection.getByRole('heading', { name: 'Sign in' }).waitFor()
      assert.equal((await User.findByOrFail('id', user.id)).email, 'morgan.new@example.test')
      await otherSession.goto('/account')
      await otherSession.getByRole('heading', { name: 'Sign in' }).waitFor()

      const passwordContext = await browser.newContext({ baseURL: origin })
      const otherPasswordSession = await passwordContext.visit('/login')
      await otherPasswordSession.getByLabel('Email').fill('morgan.new@example.test')
      await otherPasswordSession.getByLabel('Password').fill('OldPassword123!')
      await otherPasswordSession.getByRole('button', { name: 'Sign in' }).click()
      await otherPasswordSession.getByRole('heading', { name: 'Your account' }).waitFor()

      await primary.goto('/login')
      await primary.getByLabel('Email').fill('morgan.new@example.test')
      await primary.getByLabel('Password').fill('OldPassword123!')
      await primary.getByRole('button', { name: 'Sign in' }).click()
      await primary.getByRole('heading', { name: 'Your account' }).waitFor()
      await primary.goto('/settings/password')
      await primary.getByLabel('Current password').fill('OldPassword123!')
      await primary.getByLabel('New password').fill('NewPassword123!')
      await primary.getByLabel('Confirm new password').fill('NewPassword123!')
      await primary.getByRole('button', { name: 'Change password' }).click()
      await primary.getByText('Password changed. Other sessions have been signed out.').waitFor()
      assert.isNotNull(await User.verifyCredentials('morgan.new@example.test', 'NewPassword123!'))
      await otherPasswordSession.goto('/account')
      await otherPasswordSession.getByRole('heading', { name: 'Sign in' }).waitFor()
      await primary.getByRole('button', { name: 'Log out' }).click()
      await primary.getByRole('heading', { name: 'Sign in' }).waitFor()
      assert.equal(new URL(primary.url()).pathname, '/login')
      await passwordContext.close()
      await inspection.close()
    } finally {
      await otherContext.close()
    }
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
      accountKitNotifications.notify.accountActivationProvision = notify
      await page.getByRole('button', { name: 'Send a fresh verification link' }).click()
      await page.getByText(/A fresh verification link was sent/).waitFor()
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
    const token = 'expired-proof-token'
    await db.table('email_verification_tokens').insert({
      tokenable_id: user.id,
      email: user.email,
      current_email: '',
      purpose: 'activation',
      hash: createHash('sha256').update(token).digest('hex'),
      expires_at: DateTime.now().minus({ minutes: 1 }).toSQL(),
      created_at: DateTime.now().minus({ minutes: 2 }).toSQL(),
    })
    const page = await visit(`/verify-email/${encodeURIComponent(token)}`)
    await page.getByText(/This link is invalid, already used, or expired/).waitFor()
    assert.isNull((await User.findByOrFail('id', user.id)).emailVerifiedAt)
  })
})
