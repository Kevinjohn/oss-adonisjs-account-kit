import { test } from '@japa/runner'
import User from '#models/user'
import { setupAccountDatabase } from '../helpers/account_database.js'

test.group('native form validation', (group) => {
  group.each.setup(setupAccountDatabase)

  test('signup rejects a whitespace-only name on the server without retaining credentials', async ({
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
      const csrf = (await context.cookies()).find((cookie) => cookie.name === 'XSRF-TOKEN')
      assert.exists(csrf)

      const response = await context.request.post('/signup', {
        maxRedirects: 0,
        form: {
          fullName: '   ',
          email: 'native-validation-vue@example.test',
          ...markers,
        },
        headers: {
          'x-xsrf-token': decodeURIComponent(csrf!.value),
          'referer': new URL('/signup', process.env.APP_URL).href,
        },
      })

      assert.equal(response.status(), 302)
      const flash = await context.getFlashMessages()
      const session = await context.getSession()
      assert.isArray(flash.inputErrorsBag?.fullName)
      assert.deepEqual(flash.input, {
        fullName: '   ',
        email: 'native-validation-vue@example.test',
      })
      const persisted = JSON.stringify({ session, flash })
      for (const marker of Object.values(markers)) assert.notInclude(persisted, marker)
      assert.isNull(await User.findBy('email', 'native-validation-vue@example.test'))

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
      assert.equal(
        (await User.findBy('email', 'native-valid-vue@example.test'))?.fullName,
        'x'.repeat(255)
      )
    } finally {
      await context.close()
    }
  })
})
