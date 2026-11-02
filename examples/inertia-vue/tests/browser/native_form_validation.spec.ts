import { test } from '@japa/runner'
import User from '#models/user'
import { setupAccountDatabase } from '../helpers/account_database.js'

/** Session.commit flattens its input bag into top-level flash entries. */
function oldInputFromFlash(flash: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(flash).filter(([key]) => !['errorsBag', 'inputErrorsBag'].includes(key))
  )
}

test.group('native form validation', (group) => {
  group.each.setup(setupAccountDatabase)

  test('signup rejects an overlong name on the server without retaining credentials', async ({
    browser,
    assert,
  }) => {
    const context = await browser.newContext({ baseURL: process.env.APP_URL })
    const markers = {
      password: 'SignupSecret-Vue-001!',
      passwordConfirmation: 'SignupSecret-Vue-002!',
      currentPassword: 'SignupSecret-Vue-003!',
      cancelCurrentPassword: 'SignupSecret-Vue-004!',
    }

    try {
      await context.initiateSession()
      await context.request.get('/signup')
      const cookies = await context.cookies()
      const csrf = cookies.find((cookie) => cookie.name === 'XSRF-TOKEN')
      assert.exists(csrf)

      const response = await context.request.post('/signup', {
        maxRedirects: 0,
        form: {
          fullName: 'x'.repeat(256),
          email: 'native-validation-vue@example.test',
          ...markers,
        },
        headers: {
          'x-xsrf-token': decodeURIComponent(csrf!.value),
          'referer': new URL('/signup', process.env.APP_URL).href,
        },
      })

      assert.equal(response.status(), 302)
      const rejectedUser = await User.findBy('email', 'native-validation-vue@example.test')
      const flash = await context.getFlashMessages()
      const session = await context.getSession()
      assert.isArray(flash.inputErrorsBag?.fullName)
      assert.deepEqual(oldInputFromFlash(flash), {
        fullName: 'x'.repeat(256),
        email: 'native-validation-vue@example.test',
      })
      const persisted = JSON.stringify({ session, flash })
      for (const marker of Object.values(markers)) assert.notInclude(persisted, marker)
      assert.isNull(rejectedUser)

      const validResponse = await context.request.post('/signup', {
        maxRedirects: 0,
        form: {
          fullName: `  ${'x'.repeat(255)}  `,
          email: 'native-valid-vue@example.test',
          password: 'SignupPass123!',
          passwordConfirmation: 'SignupPass123!',
        },
        headers: {
          'x-xsrf-token': decodeURIComponent(csrf!.value),
          'referer': new URL('/signup', process.env.APP_URL).href,
        },
      })
      assert.equal(validResponse.status(), 302)
      const acceptedUser = await User.findBy('email', 'native-valid-vue@example.test')
      assert.equal(acceptedUser?.fullName, 'x'.repeat(255))
    } finally {
      await context.close()
    }
  })

  test('signup stores omitted and blank names as null', async ({ browser, assert }) => {
    for (const [index, name] of [undefined, '   '].entries()) {
      const email = `optional-name-vue-${index}@example.test`
      const context = await browser.newContext({ baseURL: process.env.APP_URL })
      try {
        await context.initiateSession()
        await context.request.get('/signup')
        const cookies = await context.cookies()
        const csrf = cookies.find((cookie) => cookie.name === 'XSRF-TOKEN')
        assert.exists(csrf)

        const response = await context.request.post('/signup', {
          maxRedirects: 0,
          form: {
            ...(name === undefined ? {} : { fullName: name }),
            email,
            password: 'SignupPass123!',
            passwordConfirmation: 'SignupPass123!',
          },
          headers: {
            'x-xsrf-token': decodeURIComponent(csrf!.value),
            'referer': new URL('/signup', process.env.APP_URL).href,
          },
        })
        assert.equal(response.status(), 302)
        const registered = await User.findByOrFail('email', email)
        assert.isNull(registered.fullName)
      } finally {
        await context.close()
      }
    }
  })
})
