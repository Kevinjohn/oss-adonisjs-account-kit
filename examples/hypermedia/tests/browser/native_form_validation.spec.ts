import { test } from '@japa/runner'
import { Session } from '@adonisjs/session'
import User from '#models/user'
import { setupAccountDatabase } from '../helpers/account_database.js'

/** Session.commit flattens input fields beside the framework validation bags. */
function oldInputFromFlash(flash: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(flash).filter(([key]) => !['errorsBag', 'inputErrorsBag'].includes(key))
  )
}

test.group('native form validation', (group) => {
  group.each.setup(setupAccountDatabase)

  test('signup rejects an overlong name and keeps credential markers out of old input', async ({
    browser,
    assert,
  }) => {
    const context = await browser.newContext({
      baseURL: process.env.APP_URL,
      javaScriptEnabled: false,
    })
    const markers = {
      password: 'SignupSecret-Edge-001!',
      passwordConfirmation: 'SignupSecret-Edge-002!',
    }

    try {
      await context.initiateSession()
      const page = await context.visit('/signup')
      const csrf = await page.locator('input[name="_csrf"]').inputValue()
      assert.isNotEmpty(csrf)

      const sessionPrototype = Session.prototype as unknown as {
        flash: (this: Session, key: string, value: unknown) => void
        put: (this: Session, key: string, value: unknown) => void
      }
      const originalFlash = sessionPrototype.flash
      const originalPut = sessionPrototype.put
      let flashedErrors: Record<string, unknown> = {}
      let committedFlash: Record<string, unknown> = {}
      sessionPrototype.flash = function (key, value) {
        if (key === 'inputErrorsBag') flashedErrors = value as Record<string, unknown>
        return originalFlash.call(this, key, value)
      }
      sessionPrototype.put = function (key, value) {
        if (key === this.flashKey) committedFlash = value as Record<string, unknown>
        return originalPut.call(this, key, value)
      }
      const postResponse = page.waitForResponse(
        (response) =>
          response.request().method() === 'POST' && new URL(response.url()).pathname === '/signup'
      )
      try {
        await page.getByLabel('Full name').fill('x'.repeat(256))
        await page.getByLabel('Email').fill('native-validation-edge@example.test')
        await page.getByLabel('Password', { exact: true }).fill(markers.password)
        await page.getByLabel('Confirm password').fill(markers.passwordConfirmation)
        await page.getByRole('button', { name: 'Create account' }).click()
        const response = await postResponse
        assert.equal(response.status(), 302)
      } finally {
        sessionPrototype.flash = originalFlash
        sessionPrototype.put = originalPut
      }

      assert.isArray(flashedErrors.fullName)
      assert.isNotEmpty(flashedErrors.fullName)
      assert.deepEqual(Object.keys(committedFlash.errorsBag as object), ['E_VALIDATION_ERROR'])
      assert.isObject(committedFlash.inputErrorsBag)
      assert.deepEqual(oldInputFromFlash(committedFlash), {
        fullName: 'x'.repeat(256),
        email: 'native-validation-edge@example.test',
      })
      const persisted = JSON.stringify(committedFlash)
      for (const marker of Object.values(markers)) assert.notInclude(persisted, marker)
      const rejectedUser = await User.findBy('email', 'native-validation-edge@example.test')
      assert.isNull(rejectedUser)

      await page.getByLabel('Full name').fill(`  ${'x'.repeat(255)}  `)
      await page.getByLabel('Email').fill('native-valid-edge@example.test')
      await page.getByLabel('Password', { exact: true }).fill('SignupPass123!')
      await page.getByLabel('Confirm password').fill('SignupPass123!')
      const validPostResponse = page.waitForResponse(
        (response) =>
          response.request().method() === 'POST' && new URL(response.url()).pathname === '/signup'
      )
      await page.getByRole('button', { name: 'Create account' }).click()
      const validResponse = await validPostResponse
      assert.equal(validResponse.status(), 302)
      const acceptedUser = await User.findBy('email', 'native-valid-edge@example.test')
      assert.equal(acceptedUser?.fullName, 'x'.repeat(255))
    } finally {
      await context.close()
    }
  })

  test('signup stores omitted and blank names as null', async ({ browser, assert }) => {
    for (const [index, name] of [undefined, '   '].entries()) {
      const email = `optional-name-edge-${index}@example.test`
      const context = await browser.newContext({
        baseURL: process.env.APP_URL,
        javaScriptEnabled: false,
      })

      try {
        await context.initiateSession()
        const page = await context.visit('/signup')
        if (name !== undefined) await page.getByLabel('Full name').fill(name)
        await page.getByLabel('Email').fill(email)
        await page.getByLabel('Password', { exact: true }).fill('SignupPass123!')
        await page.getByLabel('Confirm password').fill('SignupPass123!')
        await page.getByRole('button', { name: 'Create account' }).click()
        await page.getByRole('heading', { name: 'Your account' }).waitFor()
        const registered = await User.findByOrFail('email', email)
        assert.isNull(registered.fullName)
      } finally {
        await context.close()
      }
    }
  })
})
