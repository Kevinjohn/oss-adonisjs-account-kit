import { test } from '@japa/runner'
import { errors as authErrors } from '@adonisjs/auth'
import db from '@adonisjs/lucid/services/db'
import kit from '@kevinjohn/adonisjs-account-kit/services/main'
import { DateTime } from 'luxon'
import User from '#models/user'
import { setupAccountDatabase } from '../helpers/account_database.js'
import { notifyOverrides, lifecycleOverrides } from '../../config/account_kit.js'

test.group('Signup recovery in the browser', (group) => {
  group.each.setup(setupAccountDatabase)

  for (const failure of ['delivery', 'observer'] as const) {
    test(`signup preserves committed state after ${failure} failure and recovers after cooldown`, async ({
      visit,
      assert,
    }) => {
      const email = `${failure}-signup@example.test`
      const originalProvision = notifyOverrides.accountActivationProvision
      const originalObserver = lifecycleOverrides.run
      let deliveries = 0
      let receivedUrl: string | undefined
      let initialUrl: string | undefined
      notifyOverrides.accountActivationProvision = async (_user, url) => {
        deliveries += 1
        initialUrl ??= url
        if (failure === 'delivery' && deliveries === 1) throw new Error('private transport detail')
        receivedUrl = url
      }
      lifecycleOverrides.run = async (event) => {
        if (
          failure === 'observer' &&
          (event as { type?: string }).type === 'registration.created'
        ) {
          throw new Error('private observer detail')
        }
      }
      try {
        const page = await visit('/signup')
        await page.getByLabel('Email').fill(email)
        await page.getByLabel('Password', { exact: true }).fill('DeliveryPass123!')
        await page.getByLabel('Confirm password').fill('DeliveryPass123!')
        await page.getByRole('button', { name: 'Create account' }).click()
        await page.waitForURL('**/dashboard')
        await page
          .getByText(
            failure === 'delivery'
              ? 'Your account was created, but the verification email could not be sent. Use the dashboard resend action after one minute if you need a new link.'
              : 'Your account was created, but a follow-up step failed. A verification email may not have been sent. Use the dashboard resend action after one minute if you need a new link.'
          )
          .waitFor()
        assert.notInclude(await page.locator('body').innerText(), 'private ')
        const user = await User.findByOrFail('email', email)
        assert.equal(user.unverifiedEmail, email)
        assert.isNull(user.emailVerifiedAt)
        const tokens = () => db.from('email_verification_tokens').where('tokenable_id', user.id)
        assert.lengthOf(await tokens(), 1)
        const originalHash = (await tokens().first())!.hash
        assert.equal(deliveries, 1)
        await page.getByRole('button', { name: 'Resend link' }).click()
        await page
          .getByText('A current verification link may already be in your email.', {
            exact: false,
          })
          .waitFor()
        assert.equal(deliveries, 1)
        assert.equal((await tokens().first())!.hash, originalHash)
        assert.notInclude(await page.locator('body').innerText(), 'private ')
        await tokens().update({ created_at: DateTime.utc().minus({ minutes: 2 }).toISO() })
        const response = page.waitForResponse(
          (result) =>
            result.request().method() === 'POST' &&
            new URL(result.url()).pathname === '/email-verification'
        )
        await page.getByRole('button', { name: 'Resend link' }).click()
        const resendResult = await response
        assert.isBelow(resendResult.status(), 400)
        assert.equal(deliveries, 2)
        assert.notEqual((await tokens().first())!.hash, originalHash)
        assert.isString(receivedUrl)
        assert.isFalse(
          await kit.emailVerification.inspect({
            token: new URL(initialUrl!).pathname.split('/').at(-1)!,
          })
        )
        await page.goto(new URL(receivedUrl!).pathname)
        await page.getByLabel('Password', { exact: true }).fill('RecoveredPass123!')
        await page.getByLabel('Confirm password').fill('RecoveredPass123!')
        await page.getByRole('button', { name: 'Confirm email' }).click()
        await page.waitForURL('**/login')
        const confirmed = await User.findOrFail(user.id)
        assert.isNotNull(confirmed.emailVerifiedAt)
        assert.lengthOf(await tokens(), 0)
      } finally {
        notifyOverrides.accountActivationProvision = originalProvision
        lifecycleOverrides.run = originalObserver
      }
    })
  }

  test('resend delivery failure uses the real global handler without exposing its cause', async ({
    visit,
    assert,
  }) => {
    const user = await User.create({
      email: 'global-delivery@example.test',
      unverifiedEmail: 'global-delivery@example.test',
      password: 'GlobalPass123!',
    })
    const original = notifyOverrides.accountActivationProvision
    let deliveries = 0
    notifyOverrides.accountActivationProvision = async () => {
      deliveries += 1
      throw new Error('private global transport detail')
    }
    try {
      const page = await visit('/login')
      await page.getByLabel('Email').fill(user.email)
      await page.getByLabel('Password').fill('GlobalPass123!')
      await page.getByRole('button', { name: 'Sign in' }).click()
      await page.waitForURL('**/dashboard')
      await page.getByRole('button', { name: 'Resend link' }).click()
      await page
        .getByText(
          'Your change was saved, but the email could not be sent. If you need a verification link, wait one minute before requesting another.'
        )
        .waitFor()
      assert.equal(deliveries, 1)
      assert.lengthOf(await db.from('email_verification_tokens').where('tokenable_id', user.id), 1)
      assert.notInclude(await page.locator('body').innerText(), 'private global transport detail')
    } finally {
      notifyOverrides.accountActivationProvision = original
    }
  })

  for (const failure of ['delivery', 'observer', 'wrong password'] as const) {
    test(`password update ${failure} preserves committed feedback and session boundaries`, async ({
      visit,
      browser,
      assert,
    }) => {
      // Database truncation reuses low IDs; the in-memory limiter survives between cases.
      const ownerId = failure === 'delivery' ? 1001 : failure === 'observer' ? 1002 : 1003
      const user = await User.create({
        id: ownerId,
        email: `global-${failure.replace(' ', '-')}@example.test`,
        password: 'GlobalPass123!',
      })
      const originalObserver = lifecycleOverrides.run
      const originalNotice = notifyOverrides.passwordChanged
      let observers = 0
      let notices = 0
      lifecycleOverrides.run = async (event) => {
        if ((event as { type?: string }).type !== 'password.changed') return
        observers += 1
        if (failure === 'observer') throw new Error('private global observer detail')
      }
      notifyOverrides.passwordChanged = async () => {
        notices += 1
        if (failure === 'delivery') throw new Error('private global transport detail')
      }
      const secondContext = await browser.newContext({ baseURL: process.env.APP_URL })
      try {
        const page = await visit('/login')
        const secondPage = await secondContext.visit('/login')
        for (const current of [page, secondPage]) {
          await current.getByLabel('Email').fill(user.email)
          await current.getByLabel('Password').fill('GlobalPass123!')
          await current.getByRole('button', { name: 'Sign in' }).click()
          await current.waitForURL('**/dashboard')
        }
        await page.goto('/settings/password')
        await page.route('**/settings/password', async (route) => {
          if (route.request().method() !== 'POST' || failure === 'wrong password')
            return route.continue()
          const headers = { ...route.request().headers() }
          if (failure === 'delivery') delete headers.referer
          else headers.referer = 'https://untrusted.example/password?secret=private'
          await route.continue({ url: `${route.request().url()}?secret=private`, headers })
        })
        await page
          .getByLabel('Current password', { exact: true })
          .fill(failure === 'wrong password' ? 'IncorrectPass123!' : 'GlobalPass123!')
        await page.getByLabel('New password', { exact: true }).fill('ChangedPass123!')
        await page.getByLabel('Confirm new password').fill('ChangedPass123!')
        const pending = page.waitForResponse(
          (response) =>
            response.request().method() === 'POST' &&
            new URL(response.url()).pathname === '/settings/password'
        )
        await page.getByRole('button', { name: 'Change password', exact: true }).click()
        const response = await pending
        if (failure === 'wrong password') {
          await page.getByText('The password is incorrect.').waitFor()
          assert.equal(observers, 0)
          assert.equal(notices, 0)
          const unchanged = await User.verifyCredentials(user.email, 'GlobalPass123!')
          assert.equal(unchanged.id, user.id)
          await assert.rejects(
            () => User.verifyCredentials(user.email, 'ChangedPass123!'),
            authErrors.E_INVALID_CREDENTIALS
          )
          // The ordinary noncommitted error must not end either existing session.
          for (const current of [page, secondPage]) {
            await current.goto('/dashboard')
            await current.waitForURL('**/dashboard')
          }
          return
        }
        // The change committed, so this session stays on its new revision and the others end.
        assert.equal(response.headers().location, '/settings/password')
        await page.waitForURL('**/settings/password')
        assert.equal(new URL(page.url()).search, '')
        await page
          .getByText(
            failure === 'delivery'
              ? 'Password changed. Other devices have been signed out. The notification email could not be sent.'
              : 'Password changed. Other devices have been signed out. A follow-up step failed.'
          )
          .waitFor()
        assert.equal(observers, 1)
        assert.equal(notices, 1)
        const confirmed = await User.verifyCredentials(user.email, 'ChangedPass123!')
        assert.equal(confirmed.id, user.id)
        await assert.rejects(
          () => User.verifyCredentials(user.email, 'GlobalPass123!'),
          authErrors.E_INVALID_CREDENTIALS
        )
        const body = await page.locator('body').innerText()
        assert.notInclude(body, 'private')
        assert.notInclude(body, 'ChangedPass123!')
        assert.notInclude(body, 'GlobalPass123!')
        await page.goto('/dashboard')
        await page.waitForURL('**/dashboard')
        await secondPage.goto('/dashboard')
        await secondPage.waitForURL('**/login')
      } finally {
        lifecycleOverrides.run = originalObserver
        notifyOverrides.passwordChanged = originalNotice
        await secondContext.close()
      }
    })
  }

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
