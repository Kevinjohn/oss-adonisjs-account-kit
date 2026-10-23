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
import { errors } from 'adonisjs-account-kit'
import kit from 'adonisjs-account-kit/services/main'

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

  test('reset acknowledgement is generic and revokes both old sessions through the original login', async ({
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
    const consumedProofContext = await browser.newContext({ baseURL: origin })
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
      const firstSession = requester
      await firstSession.goto('/login')
      await firstSession.getByLabel('Email').fill(user.email)
      await firstSession.getByLabel('Password').fill('OldPassword123!')
      await firstSession.getByRole('button', { name: 'Sign in' }).click()
      await firstSession.getByRole('heading', { name: 'Your account' }).waitFor()
      await firstSession.goto('/dashboard')
      await firstSession.getByText('Signed in as morgan@example.test.').waitFor()

      const secondSession = await secondContext.visit('/login')
      await secondSession.getByLabel('Email').fill(user.email)
      await secondSession.getByLabel('Password').fill('OldPassword123!')
      await secondSession.getByRole('button', { name: 'Sign in' }).click()
      await secondSession.getByRole('heading', { name: 'Your account' }).waitFor()
      await secondSession.goto('/dashboard')
      await secondSession.getByText('Signed in as morgan@example.test.').waitFor()

      const consumedProofPage = await consumedProofContext.visit(resetPath)
      await consumedProofPage.getByRole('heading', { name: 'Choose a new password' }).waitFor()
      await secondSession.goto(resetPath)
      await secondSession.getByRole('heading', { name: 'Choose a new password' }).waitFor()
      await requester.goto(resetPath)
      await requester.getByRole('heading', { name: 'Choose a new password' }).waitFor()
      assert.isNotNull(await User.findByOrFail('id', user.id))
      await requester.getByLabel('New password').fill('NewPassword123!')
      await requester.getByLabel('Confirm password').fill('NewPassword123!')
      await requester.getByRole('button', { name: 'Reset password' }).click()
      await requester.getByRole('heading', { name: 'Sign in' }).waitFor()

      const newPasswordHash = (await db
        .from('users')
        .select('password')
        .where('id', user.id)
        .first())!.password

      for (const client of [firstSession, secondSession]) {
        await client.goto('/dashboard')
        await client.getByRole('heading', { name: 'Sign in' }).waitFor()
      }

      await requester.goto(resetPath)
      await requester.getByText(/invalid, already used, or expired/).waitFor()
      assert.isNotNull(await User.verifyCredentials(user.email, 'NewPassword123!'))

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
      await requester.getByRole('heading', { name: 'Your account' }).waitFor()
      await requester.goto('/dashboard')
      await requester.getByText('Signed in as morgan@example.test.').waitFor()
      const assertCurrentSession = async () => {
        const response = await requester.request.get(`${origin}/dashboard`, { maxRedirects: 0 })
        assert.equal(response.status(), 200)
        assert.equal(new URL(response.url()).pathname, '/dashboard')
      }
      await assertCurrentSession()
      await consumedProofPage.getByLabel('New password').fill('AnotherPassword123!')
      await consumedProofPage.getByLabel('Confirm password').fill('AnotherPassword123!')
      await consumedProofPage.getByRole('button', { name: 'Reset password' }).click()
      const consumedFeedback = await consumedProofPage.locator('body').innerText()
      assert.include(
        consumedFeedback,
        'This reset link is invalid, already used, or expired. Request a fresh link.'
      )
      assert.isTrue(
        await consumedProofPage
          .getByText('This reset link is invalid, already used, or expired. Request a fresh link.')
          .isVisible()
      )
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
      await secondContext.close()
      await consumedProofContext.close()
    }
  })

  test('malformed and expired reset POSTs are rejected without changing credentials or proof state', async ({
    visit,
    browserContext,
    assert,
  }) => {
    accountKitNotifications.clear()
    const user = await User.create({
      fullName: 'Expired Reset',
      email: 'expired-reset@example.test',
      password: 'OldPassword123!',
      emailVerifiedAt: DateTime.now(),
      unverifiedEmail: null,
    })
    const token = randomBytes(40).toString('base64url')
    const expiredHash = createHash('sha256').update(token).digest('hex')
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
      fullName: 'Reset Form Owner',
      email: 'reset-form-owner@example.test',
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
    const page = await visit('/forgot-password')
    await page.getByLabel('Email').fill(formOwner.email)
    await page.getByRole('button', { name: 'Send reset link' }).click()
    await page
      .getByText('If an account exists for that address, we have sent a reset link.')
      .waitFor()
    const validToken = accountKitNotifications.tokenFor('passwordResetProvision', formOwner.email)
    const validHash = createHash('sha256').update(validToken).digest('hex')
    const validProof = await db
      .from('password_reset_tokens')
      .where('tokenable_id', formOwner.id)
      .where('hash', validHash)
      .first()
    assert.isNotNull(validProof)

    const activeSession = await browserContext.visit('/login')
    await activeSession.goto('/login')
    await activeSession.getByLabel('Email').fill(user.email)
    await activeSession.getByLabel('Password').fill('OldPassword123!')
    await activeSession.getByRole('button', { name: 'Sign in' }).click()
    await activeSession.waitForURL('**/dashboard')
    const assertActiveSession = async () => {
      const response = await activeSession.request.get(`${origin}/dashboard`, { maxRedirects: 0 })
      assert.equal(response.status(), 200)
      assert.equal(new URL(response.url()).pathname, '/dashboard')
    }
    for (const rejectedToken of ['not-a-proof', token]) {
      await assertActiveSession()
      await page.goto(`/reset-password/${encodeURIComponent(validToken)}`)
      await page.getByRole('heading', { name: 'Choose a new password' }).waitFor()
      await page
        .locator('form')
        .evaluate(
          (form, action) => form.setAttribute('action', action),
          `/reset-password/${encodeURIComponent(rejectedToken)}`
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
      assert.isNotNull(await User.verifyCredentials(user.email, 'OldPassword123!'))
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
      await assertActiveSession()
    }
  })

  test('a mismatched reset submission clears password fields and preserves the current password', async ({
    browser,
    assert,
  }) => {
    accountKitNotifications.clear()
    const user = await User.create({
      fullName: 'Mismatch Reset',
      email: 'mismatch-reset@example.test',
      password: 'OldPassword123!',
      emailVerifiedAt: DateTime.now(),
      unverifiedEmail: null,
    })
    const originalHash = (await db.from('users').select('password').where('id', user.id).first())!
      .password
    const context = await browser.newContext({ baseURL: origin, javaScriptEnabled: false })
    try {
      const requester = await context.visit('/forgot-password')
      await requester.getByLabel('Email').fill(user.email)
      await requester.getByRole('button', { name: 'Send reset link' }).click()
      await requester
        .getByText('If an account exists for that address, we have sent a reset link.')
        .waitFor()
      const token = accountKitNotifications.tokenFor('passwordResetProvision', user.email)
      const proofHash = createHash('sha256').update(token).digest('hex')
      const expectedProof = await db
        .from('password_reset_tokens')
        .where('tokenable_id', user.id)
        .where('hash', proofHash)
        .first()
      assert.isNotNull(expectedProof)
      await requester.goto('/login')
      await requester.getByLabel('Email').fill(user.email)
      await requester.getByLabel('Password').fill('OldPassword123!')
      await requester.getByRole('button', { name: 'Sign in' }).click()
      await requester.waitForURL('**/dashboard')
      const assertPreserved = async () => {
        const response = await requester.request.get(`${origin}/dashboard`, { maxRedirects: 0 })
        assert.equal(response.status(), 200)
        assert.equal(new URL(response.url()).pathname, '/dashboard')
        assert.deepEqual(
          await db
            .from('password_reset_tokens')
            .where('tokenable_id', user.id)
            .where('hash', proofHash)
            .first(),
          expectedProof
        )
      }
      await assertPreserved()

      await requester.goto(`/reset-password/${encodeURIComponent(token)}`)
      await requester.getByRole('heading', { name: 'Choose a new password' }).waitFor()
      await requester.getByLabel('New password').fill('ReplacementPass123!')
      await requester.getByLabel('Confirm password').fill('DifferentPass123!')
      await requester.getByRole('button', { name: 'Reset password' }).click()
      await requester.getByText('Confirm password must match Password.').waitFor()
      assert.equal(await requester.getByLabel('New password').inputValue(), '')
      assert.equal(await requester.getByLabel('Confirm password').inputValue(), '')
      assert.isNotNull(await User.verifyCredentials(user.email, 'OldPassword123!'))
      assert.equal(
        (await db.from('users').select('password').where('id', user.id).first())!.password,
        originalHash
      )
      await assertPreserved()
    } finally {
      await context.close()
    }
  })

  test('requesting a replacement reset link invalidates the first without changing credentials', async ({
    visit,
    assert,
  }) => {
    accountKitNotifications.clear()
    const user = await User.create({
      fullName: 'Replacement Reset',
      email: 'replacement-reset@example.test',
      password: 'OldPassword123!',
      emailVerifiedAt: DateTime.now(),
      unverifiedEmail: null,
    })
    const originalHash = (await db.from('users').select('password').where('id', user.id).first())!
      .password
    const page = await visit('/forgot-password')
    await page.getByLabel('Email').fill(user.email)
    await page.getByRole('button', { name: 'Send reset link' }).click()
    await page
      .getByText('If an account exists for that address, we have sent a reset link.')
      .waitFor()
    const firstToken = accountKitNotifications.tokenFor('passwordResetProvision', user.email)

    await page.goto('/forgot-password')
    await page.getByLabel('Email').fill(user.email)
    await page.getByRole('button', { name: 'Send reset link' }).click()
    const replacementAcknowledgement = await page.locator('body').innerText()
    assert.include(
      replacementAcknowledgement,
      'If an account exists for that address, we have sent a reset link.',
      `Unexpected replacement request response at ${page.url()}`
    )
    assert.isTrue(
      await page
        .getByText('If an account exists for that address, we have sent a reset link.')
        .isVisible()
    )
    const replacementToken = accountKitNotifications.tokenFor('passwordResetProvision', user.email)
    const proofHash = createHash('sha256').update(replacementToken).digest('hex')
    const expectedProof = await db
      .from('password_reset_tokens')
      .where('tokenable_id', user.id)
      .where('hash', proofHash)
      .first()
    assert.isNotNull(expectedProof)
    await page.goto('/login')
    await page.getByLabel('Email').fill(user.email)
    await page.getByLabel('Password').fill('OldPassword123!')
    await page.getByRole('button', { name: 'Sign in' }).click()
    await page.waitForURL('**/dashboard')
    const assertPreserved = async () => {
      const response = await page.request.get(`${origin}/dashboard`, { maxRedirects: 0 })
      assert.equal(response.status(), 200)
      assert.equal(new URL(response.url()).pathname, '/dashboard')
      assert.deepEqual(
        await db
          .from('password_reset_tokens')
          .where('tokenable_id', user.id)
          .where('hash', proofHash)
          .first(),
        expectedProof
      )
    }
    await assertPreserved()

    await page.goto(`/reset-password/${encodeURIComponent(firstToken)}`)
    await page.getByText(/This link is invalid, already used, or expired/).waitFor()
    await page.goto(`/reset-password/${encodeURIComponent(replacementToken)}`)
    await page.getByRole('heading', { name: 'Choose a new password' }).waitFor()
    await page
      .locator('form')
      .evaluate(
        (form, action) => form.setAttribute('action', action),
        `/reset-password/${encodeURIComponent(firstToken)}`
      )
    await page.getByLabel('New password').fill('ReplacementPass123!')
    await page.getByLabel('Confirm password').fill('ReplacementPass123!')
    await page.getByRole('button', { name: 'Reset password' }).click()
    await page.getByText(/This reset link is invalid, already used, or expired/).waitFor()
    assert.isNotNull(await User.verifyCredentials(user.email, 'OldPassword123!'))
    assert.equal(
      (await db.from('users').select('password').where('id', user.id).first())!.password,
      originalHash
    )
    await assertPreserved()
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
    await javascriptPage.getByLabel('Email').fill('unknown@example.test')
    await javascriptPage.getByLabel('Password').fill('UnknownPass123!')
    await javascriptPage.getByRole('button', { name: 'Sign in' }).click()
    const javascriptError = javascriptPage.getByText(errorMessage)
    await javascriptError.waitFor()
    await javascriptPage.waitForTimeout(5100)
    assert.isTrue(await javascriptError.isVisible())
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
    const emailOwner = await User.create({
      fullName: 'Email Owner',
      email: 'email-owner@example.test',
      password: 'EmailOwnerPassword123!',
      emailVerifiedAt: DateTime.now(),
      unverifiedEmail: null,
    })
    const otherContext = await browser.newContext({ baseURL: origin })
    const emailContext = await browser.newContext({ baseURL: origin })
    try {
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
      const otherPasswordSession = await passwordContext.visit('/login')
      await otherPasswordSession.getByLabel('Email').fill(user.email)
      await otherPasswordSession.getByLabel('Password').fill('OldPassword123!')
      await otherPasswordSession.getByRole('button', { name: 'Sign in' }).click()
      await otherPasswordSession.getByRole('heading', { name: 'Your account' }).waitFor()

      const passwordPrimaryContext = await browser.newContext({ baseURL: origin })
      const passwordPrimary = await passwordPrimaryContext.visit('/login')
      await passwordPrimary.getByLabel('Email').fill(user.email)
      await passwordPrimary.getByLabel('Password').fill('OldPassword123!')
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
      await passwordPrimary.getByLabel('Current password').fill('OldPassword123!')
      await passwordPrimary.getByLabel('New password', { exact: true }).fill('NewPassword123!')
      await passwordPrimary.getByLabel('Confirm new password').fill('NewPassword123!')
      await passwordPrimary.getByRole('button', { name: 'Change password' }).click()
      await passwordPrimary
        .getByText('Password changed. Other sessions have been signed out.')
        .waitFor()
      assert.isNotNull(await User.verifyCredentials(user.email, 'NewPassword123!'))
      await otherPasswordSession.goto('/account')
      await otherPasswordSession.getByRole('heading', { name: 'Sign in' }).waitFor()
      const newEmailContext = await browser.newContext({ baseURL: origin })
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
      await replayContext.addCookies([savedSessionCookie!])
      await passwordPrimary.getByRole('button', { name: 'Log out' }).click()
      await passwordPrimary.getByRole('heading', { name: 'Sign in' }).waitFor()
      assert.equal(new URL(passwordPrimary.url()).pathname, '/login')
      const replay = await replayContext.visit('/account')
      await replay.getByRole('heading', { name: 'Sign in' }).waitFor()
      await replayContext.close()
      await passwordContext.close()
      await passwordPrimaryContext.close()
      await newEmailContext.close()
      await visitorContext.close()
      await emailContext.close()
    } finally {
      await otherContext.close()
      await emailContext.close()
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
      await db
        .from('email_verification_tokens')
        .where('tokenable_id', user.id)
        .update({ created_at: DateTime.now().minus({ minutes: 2 }).toSQL() })
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
