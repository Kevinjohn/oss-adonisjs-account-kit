import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import testUtils from '@adonisjs/core/services/test_utils'
import kit from 'adonisjs-account-kit/services/main'
import { DateTime } from 'luxon'
import User from '#models/user'

type SignupConfig = {
  deps: {
    config: {
      notify: {
        accountActivationProvision: (...args: never[]) => Promise<void>
      }
    }
  }
}

test.group('Signup recovery in the browser', (group) => {
  group.each.setup(async () => {
    const truncate = await testUtils.db().truncate()
    await truncate()
    await db
      .table('account_transaction_lock')
      .insert({ id: 1, version: 0 })
      .onConflict('id')
      .ignore()

    return async () => {
      await truncate()
    }
  })

  test('keeps the account and offers dashboard resend after activation delivery fails', async ({
    visit,
    assert,
  }) => {
    const email = `delivery-${Date.now()}@example.test`
    const resolvedConfig = (kit as unknown as SignupConfig).deps.config
    const originalProvision = resolvedConfig.notify.accountActivationProvision
    resolvedConfig.notify.accountActivationProvision = async () => {
      throw new Error('private fixture delivery detail')
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
        .getByText(
          'Your account was created, but we could not confirm that the verification email was sent. Use the resend link on your dashboard to request another email.'
        )
        .waitFor()
      await page.getByRole('button', { name: 'Resend link' }).waitFor()

      const user = await User.findByOrFail('email', email)
      assert.equal(user.unverifiedEmail, email)
      assert.isNull(user.emailVerifiedAt)
      const tokensForUser = () =>
        db.from('email_verification_tokens').where('tokenable_id', user.id)
      assert.lengthOf(await tokensForUser(), 1)
      const originalToken = (await tokensForUser().first())!.hash

      let resendDeliveries = 0
      resolvedConfig.notify.accountActivationProvision = async () => {
        resendDeliveries += 1
      }
      await tokensForUser().update({
        created_at: DateTime.utc().minus({ minutes: 2 }).toJSDate(),
      })
      const resendResponse = page.waitForResponse(
        (response) =>
          response.request().method() === 'POST' &&
          new URL(response.url()).pathname === '/email-verification'
      )
      await page.getByRole('button', { name: 'Resend link' }).click()
      const response = await resendResponse
      assert.isBelow(response.status(), 400)
      await page.getByText('We have sent a new verification link.').waitFor()
      assert.equal(resendDeliveries, 1)
      assert.lengthOf(await User.query().where('email', email), 1)
      const renewedToken = await tokensForUser().first()
      assert.isNotNull(renewedToken)
      assert.notEqual(renewedToken!.hash, originalToken)
    } finally {
      resolvedConfig.notify.accountActivationProvision = originalProvision
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
