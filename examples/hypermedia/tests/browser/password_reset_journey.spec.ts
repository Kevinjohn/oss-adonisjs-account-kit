import { test } from '@japa/runner'
import { DateTime } from 'luxon'
import { createHash, randomBytes } from 'node:crypto'
import db from '@adonisjs/lucid/services/db'
import limiter from '@adonisjs/limiter/services/main'
import User from '#models/user'
import { accountKitNotifications } from '#services/account_kit_notifications'
import { setupAccountDatabase } from '#tests/helpers/account_database'

const origin = process.env.APP_URL!

test.group('native password reset journeys', (group) => {
  group.each.setup(async () => {
    const cleanup = await setupAccountDatabase()
    await limiter.clear(['memory'])
    return cleanup
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
      await requester.getByLabel('New password').fill('ReplacementPass123!')
      await requester.getByLabel('Confirm password').fill('ReplacementPass123!')
      await requester.getByRole('button', { name: 'Reset password' }).click()
      await requester.getByRole('heading', { name: 'Sign in' }).waitFor()
      assert.isNotNull(await User.verifyCredentials(user.email, 'ReplacementPass123!'))
      assert.notExists(await db.from('password_reset_tokens').where('hash', proofHash).first())
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
})
