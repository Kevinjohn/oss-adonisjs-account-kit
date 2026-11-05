import { errors as authErrors } from '@adonisjs/auth'
import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import { InvalidTokenError } from '@kevinjohn/adonisjs-account-kit'
import kit from '@kevinjohn/adonisjs-account-kit/services/main'
import { DateTime } from 'luxon'
import User from '#models/user'
import { setupAccountDatabase } from '../helpers/account_database.js'
import { lifecycleOverrides, notifyOverrides } from '../../config/account_kit.js'

test.group('Signup recovery in the browser', (group) => {
  group.each.setup(setupAccountDatabase)

  test('recovers a failed first delivery without claiming an immediate resend sent mail', async ({
    visit,
    assert,
  }) => {
    const email = `delivery-${Date.now()}@example.test`
    const originalProvision = notifyOverrides.accountActivationProvision
    let deliveries = 0
    let failedToken = ''
    let deliveredToken = ''
    notifyOverrides.accountActivationProvision = async (_user, url) => {
      deliveries += 1
      const token = new URL(url).pathname.split('/').at(-1)!
      if (deliveries === 1) {
        failedToken = token
        throw new Error('private fixture delivery detail')
      }
      deliveredToken = token
    }

    try {
      const page = await visit('/signup')
      await page.getByLabel('Full name').fill('Delivery Failure')
      await page.getByLabel('Email').fill(email)
      await page.getByLabel('Password', { exact: true }).fill('DeliveryPass123!')
      await page.getByLabel('Confirm password').fill('DeliveryPass123!')
      await page.getByRole('button', { name: 'Create account' }).click()
      await page.waitForURL('**/dashboard')
      await page
        .getByText('Your account was created, but the verification email could not be sent.', {
          exact: false,
        })
        .waitFor()
      assert.notInclude(await page.locator('body').innerText(), 'private fixture delivery detail')
      const user = await User.findByOrFail('email', email)
      assert.equal(user.unverifiedEmail, email)
      assert.isNull(user.emailVerifiedAt)
      const tokensForUser = () =>
        db.from('email_verification_tokens').where('tokenable_id', user.id)
      assert.lengthOf(await tokensForUser(), 1)
      const originalToken = (await tokensForUser().first())!.hash
      assert.equal(deliveries, 1)

      await page.getByRole('button', { name: 'Resend link' }).click()
      await page
        .getByText('A current verification link may already be in your email.', { exact: false })
        .waitFor()
      assert.equal(deliveries, 1)
      assert.equal((await tokensForUser().first())!.hash, originalToken)
      assert.notInclude(
        await page.locator('body').innerText(),
        'We have sent a new verification link.'
      )

      await tokensForUser().update({ created_at: DateTime.utc().minus({ minutes: 2 }).toJSDate() })
      const resendResponse = page.waitForResponse(
        (response) =>
          response.request().method() === 'POST' &&
          new URL(response.url()).pathname === '/email-verification'
      )
      await page.getByRole('button', { name: 'Resend link' }).click()
      const response = await resendResponse
      assert.isBelow(response.status(), 400)
      await page
        .getByText('A current verification link may already be in your email.', { exact: false })
        .waitFor()
      assert.equal(deliveries, 2)
      assert.lengthOf(await User.query().where('email', email), 1)
      assert.notEqual((await tokensForUser().first())!.hash, originalToken)
      assert.isFalse(await kit.emailVerification.inspect({ token: failedToken }))
      assert.isNotEmpty(deliveredToken)
      await page.goto(`/verify-email/${deliveredToken}`)
      await page.getByLabel('Password', { exact: true }).fill('RecoveredPass123!')
      await page.getByLabel('Confirm password').fill('RecoveredPass123!')
      await page.getByRole('button', { name: 'Confirm email' }).click()
      await page.waitForURL('**/login')
      const verifiedUser = await User.findOrFail(user.id)
      assert.isNotNull(verifiedUser.emailVerifiedAt)
      assert.isFalse(await kit.emailVerification.inspect({ token: deliveredToken }))
      await assert.rejects(
        () => kit.emailVerification.complete({ token: failedToken, password: 'UnusedPass123!' }),
        InvalidTokenError
      )
    } finally {
      notifyOverrides.accountActivationProvision = originalProvision
    }
  })

  test('signup observer failure preserves the account without claiming failed delivery', async ({
    visit,
    assert,
  }) => {
    const email = `observer-${Date.now()}@example.test`
    const previousNotify = notifyOverrides.accountActivationProvision
    const previousLifecycle = lifecycleOverrides.run
    let deliveredToken = ''
    let observed = false
    notifyOverrides.accountActivationProvision = async (_user, url) => {
      deliveredToken = new URL(url).pathname.split('/').at(-1)!
    }
    lifecycleOverrides.run = async (event) => {
      if ((event as { type?: string }).type !== 'registration.created') return
      observed = true
      throw new Error('private fixture observer detail')
    }
    try {
      const page = await visit('/signup')
      await page.getByLabel('Email').fill(email)
      await page.getByLabel('Password', { exact: true }).fill('ObserverPass123!')
      await page.getByLabel('Confirm password').fill('ObserverPass123!')
      await page.getByRole('button', { name: 'Create account' }).click()
      await page.waitForURL('**/dashboard')
      await page
        .getByText('Your account was created, but a follow-up step failed.', { exact: false })
        .waitFor()
      const text = await page.locator('body').innerText()
      assert.notInclude(text, 'could not be sent')
      assert.notInclude(text, 'private fixture observer detail')
      assert.isTrue(observed)
      assert.isTrue(await kit.emailVerification.inspect({ token: deliveredToken }))
      assert.isNotNull(await User.findBy('email', email))
    } finally {
      notifyOverrides.accountActivationProvision = previousNotify
      lifecycleOverrides.run = previousLifecycle
    }
  })

  test('resend delivery errors reach the real global handler with committed proof feedback', async ({
    visit,
    assert,
  }) => {
    const email = `global-delivery-${Date.now()}@example.test`
    const owner = await User.create({ email, unverifiedEmail: email, password: 'GlobalPass123!' })
    const previous = notifyOverrides.accountActivationProvision
    let deliveries = 0
    notifyOverrides.accountActivationProvision = async () => {
      deliveries += 1
      throw new Error('private global transport detail')
    }
    try {
      const page = await visit('/login')
      await page.getByLabel('Email').fill(email)
      await page.getByLabel('Password').fill('GlobalPass123!')
      await page.getByRole('button', { name: 'Sign in' }).click()
      await page.waitForURL('**/dashboard')
      await page.getByRole('button', { name: 'Resend link' }).click()
      await page
        .getByText('Your change was saved, but the email could not be sent.', { exact: false })
        .waitFor()
      assert.equal(deliveries, 1)
      assert.lengthOf(await db.from('email_verification_tokens').where('tokenable_id', owner.id), 1)
      assert.notInclude(await page.locator('body').innerText(), 'private global transport detail')
    } finally {
      notifyOverrides.accountActivationProvision = previous
    }
  })

  for (const failure of ['delivery', 'observer'] as const) {
    test(`password ${failure} failure gives visible global recovery after ending old sessions`, async ({
      browser,
      assert,
    }) => {
      const email = `global-${failure}-${Date.now()}@example.test`
      // Distinct ids isolate the test-mode memory limiter from truncated fixtures.
      const owner = await User.create({
        id: failure === 'delivery' ? 1001 : 1002,
        email,
        password: 'GlobalPass123!',
      })
      const previousLifecycle = lifecycleOverrides.run
      const previousNotify = notifyOverrides.passwordChanged
      let deliveries = 0
      let observed = false
      notifyOverrides.passwordChanged = async () => {
        deliveries += 1
        if (failure === 'delivery') throw new Error('private global transport detail')
      }
      lifecycleOverrides.run = async (event) => {
        if ((event as { type?: string }).type !== 'password.changed') return
        observed = true
        if (failure === 'observer') throw new Error('private global observer detail')
      }
      const context = await browser.newContext({ baseURL: process.env.APP_URL })
      const otherContext = await browser.newContext({ baseURL: process.env.APP_URL })
      try {
        const page = await context.newPage()
        const otherPage = await otherContext.newPage()
        for (const current of [page, otherPage]) {
          await current.goto('/login')
          await current.getByLabel('Email').fill(email)
          await current.getByLabel('Password').fill('GlobalPass123!')
          await current.getByRole('button', { name: 'Sign in' }).click()
          await current.waitForURL('**/dashboard')
        }
        await page.goto('/settings/password')
        const cookies = await context.cookies()
        const csrf = cookies.find((cookie) => cookie.name === 'XSRF-TOKEN')!
        const response = await context.request.post(
          '/settings/password?next=https://example.invalid/private',
          {
            form: {
              currentPassword: 'GlobalPass123!',
              password: 'ChangedPass123!',
              passwordConfirmation: 'ChangedPass123!',
            },
            headers: {
              'X-XSRF-TOKEN': decodeURIComponent(csrf.value),
              'Accept': 'text/html',
              ...(failure === 'observer'
                ? { Referer: 'https://example.invalid/hostile?secret=private' }
                : {}),
            },
            maxRedirects: 0,
          }
        )
        assert.equal(response.status(), 302)
        const destination = new URL(response.headers().location, process.env.APP_URL)
        assert.equal(destination.origin, new URL(process.env.APP_URL!).origin)
        // The change committed, so this session stays on its new revision and the others end.
        assert.equal(destination.pathname, '/settings/password')
        assert.equal(destination.search, '')
        await page.goto(destination.href)
        const message =
          failure === 'delivery'
            ? 'Password changed. Other devices have been signed out. The notification email could not be sent.'
            : 'Password changed. Other devices have been signed out. A follow-up step failed.'
        await page.getByText(message, { exact: true }).waitFor()
        const visible = await page.locator('body').innerText()
        assert.notInclude(visible, 'private global')
        assert.notInclude(visible, 'GlobalPass123!')
        assert.notInclude(visible, 'ChangedPass123!')
        if (failure === 'observer') assert.notInclude(visible, 'could not be sent')
        assert.isTrue(observed)
        assert.equal(deliveries, 1)
        await assert.rejects(
          () => User.verifyCredentials(email, 'GlobalPass123!'),
          authErrors.E_INVALID_CREDENTIALS
        )
        const changedUser = await User.verifyCredentials(email, 'ChangedPass123!')
        assert.equal(changedUser.id, owner.id)
        await otherPage.goto('/dashboard')
        await otherPage.waitForURL('**/login')
        await otherPage.getByRole('heading', { name: 'Welcome back' }).waitFor()
        await page.goto('/dashboard')
        await page.waitForURL('**/dashboard')
        await page.goto('/settings/profile')
        await page.getByText(email, { exact: true }).waitFor()
      } finally {
        lifecycleOverrides.run = previousLifecycle
        notifyOverrides.passwordChanged = previousNotify
        await context.close()
        await otherContext.close()
      }
    })
  }

  test('a wrong current password leaves credentials and both existing sessions unchanged', async ({
    browser,
    assert,
  }) => {
    const email = `password-control-${Date.now()}@example.test`
    const owner = await User.create({ id: 1003, email, password: 'GlobalPass123!' })
    const context = await browser.newContext({ baseURL: process.env.APP_URL })
    const otherContext = await browser.newContext({ baseURL: process.env.APP_URL })
    try {
      const page = await context.newPage()
      const otherPage = await otherContext.newPage()
      for (const current of [page, otherPage]) {
        await current.goto('/login')
        await current.getByLabel('Email').fill(email)
        await current.getByLabel('Password').fill('GlobalPass123!')
        await current.getByRole('button', { name: 'Sign in' }).click()
        await current.waitForURL('**/dashboard')
      }
      await page.goto('/settings/password')
      await page.getByLabel('Current password', { exact: true }).fill('WrongPass123!')
      await page.getByLabel('New password', { exact: true }).fill('ChangedPass123!')
      await page.getByLabel('Confirm new password', { exact: true }).fill('ChangedPass123!')
      await page.getByRole('button', { name: 'Change password' }).click()
      await page.getByText('The password is incorrect.', { exact: true }).waitFor()
      const unchanged = await User.verifyCredentials(email, 'GlobalPass123!')
      assert.equal(unchanged.id, owner.id)
      await assert.rejects(
        () => User.verifyCredentials(email, 'ChangedPass123!'),
        authErrors.E_INVALID_CREDENTIALS
      )
      for (const current of [page, otherPage]) {
        await current.goto('/dashboard')
        await current.getByRole('heading', { name: 'Your dashboard is ready' }).waitFor()
      }
    } finally {
      await context.close()
      await otherContext.close()
    }
  })

  test('keeps the account and offers sign in when initial session login fails', async ({
    visit,
    assert,
  }) => {
    const email = `login-${Date.now()}@example.test`
    const originalAuthentication = Object.getOwnPropertyDescriptor(kit, 'authentication')
    Object.defineProperty(kit, 'authentication', {
      configurable: true,
      get: () => ({
        login: async () => {
          throw new Error('private fixture session detail')
        },
      }),
    })

    try {
      const page = await visit('/signup')
      await page.getByLabel('Full name').fill('Login Failure')
      await page.getByLabel('Email').fill(email)
      await page.getByLabel('Password', { exact: true }).fill('LoginPass123!')
      await page.getByLabel('Confirm password').fill('LoginPass123!')
      await page.getByRole('button', { name: 'Create account' }).click()
      await page.waitForURL('**/login')

      await page
        .getByText(
          'Your account was created, but we could not sign you in. Please sign in to continue.'
        )
        .waitFor()
      assert.isNotNull(await User.findBy('email', email))
      assert.equal(new URL(page.url()).pathname, '/login')

      if (originalAuthentication)
        Object.defineProperty(kit, 'authentication', originalAuthentication)
      else Reflect.deleteProperty(kit, 'authentication')
      await page.getByLabel('Email').fill(email)
      await page.getByLabel('Password').fill('LoginPass123!')
      await page.getByRole('button', { name: 'Sign in' }).click()
      await page.waitForURL('**/dashboard')
      assert.isNotNull(await User.findBy('email', email))
    } finally {
      if (originalAuthentication)
        Object.defineProperty(kit, 'authentication', originalAuthentication)
      else Reflect.deleteProperty(kit, 'authentication')
    }
  })

  test('does not create or claim an account when signup validation fails', async ({
    visit,
    assert,
  }) => {
    const email = `invalid-${Date.now()}@example.test`
    const page = await visit('/signup')
    await page.getByLabel('Full name').fill('Invalid Signup')
    await page.getByLabel('Email').fill(email)
    await page.getByLabel('Password', { exact: true }).fill('InvalidPass123!')
    await page.getByLabel('Confirm password').fill('DifferentPass123!')
    await page.getByRole('button', { name: 'Create account' }).click()

    await page.locator('#passwordConfirmation[aria-invalid="true"]').waitFor()
    assert.isNull(await User.findBy('email', email))
    assert.isFalse(await page.getByText(/your account was created/i).isVisible())
  })
})
