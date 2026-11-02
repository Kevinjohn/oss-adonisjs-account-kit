import { test } from '@japa/runner'
import { DateTime } from 'luxon'
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
      password: 'SignupSecret-React-001!',
      passwordConfirmation: 'SignupSecret-React-002!',
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
          email: 'native-validation-react@example.test',
          ...markers,
        },
        headers: {
          'x-xsrf-token': decodeURIComponent(csrf!.value),
          'referer': new URL('/signup', process.env.APP_URL).href,
        },
      })

      assert.equal(response.status(), 302)
      const rejectedUser = await User.findBy('email', 'native-validation-react@example.test')
      const flash = await context.getFlashMessages()
      const session = await context.getSession()
      assert.isArray(flash.inputErrorsBag?.fullName)
      assert.deepEqual(oldInputFromFlash(flash), {
        fullName: 'x'.repeat(256),
        email: 'native-validation-react@example.test',
      })
      const persisted = JSON.stringify({ session, flash })
      for (const marker of Object.values(markers)) assert.notInclude(persisted, marker)
      assert.isNull(rejectedUser)

      const validResponse = await context.request.post('/signup', {
        maxRedirects: 0,
        form: {
          fullName: `  ${'x'.repeat(255)}  `,
          email: 'native-valid-react@example.test',
          password: 'SignupPass123!',
          passwordConfirmation: 'SignupPass123!',
        },
        headers: {
          'x-xsrf-token': decodeURIComponent(csrf!.value),
          'referer': new URL('/signup', process.env.APP_URL).href,
        },
      })
      assert.equal(validResponse.status(), 302)
      const acceptedUser = await User.findBy('email', 'native-valid-react@example.test')
      assert.equal(acceptedUser?.fullName, 'x'.repeat(255))
    } finally {
      await context.close()
    }
  })

  test('signup stores omitted and blank names as null', async ({ browser, assert }) => {
    for (const [index, name] of [undefined, '   '].entries()) {
      const email = `optional-name-react-${index}@example.test`
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

  test('native settings validation retains only safe input and Inertia receives errors without input flash', async ({
    browser,
    assert,
  }) => {
    const user = await User.create({
      fullName: 'Settings Owner',
      email: 'native-settings-react@example.test',
      password: 'SettingsPass123!',
      emailVerifiedAt: DateTime.now(),
      unverifiedEmail: null,
    })
    const context = await browser.newContext({ baseURL: process.env.APP_URL })

    try {
      await context.initiateSession()
      await context.request.get('/login')
      const cookies = await context.cookies()
      const csrf = cookies.find((cookie) => cookie.name === 'XSRF-TOKEN')
      assert.exists(csrf)
      const login = await context.request.post('/login', {
        maxRedirects: 0,
        form: { email: user.email, password: 'SettingsPass123!' },
        headers: {
          'x-xsrf-token': decodeURIComponent(csrf!.value),
          'referer': new URL('/login', process.env.APP_URL).href,
        },
      })
      assert.equal(login.status(), 302)

      const headersFor = (path: string) => ({
        'x-xsrf-token': decodeURIComponent(csrf!.value),
        'referer': new URL(path, process.env.APP_URL).href,
      })

      const profileMarker = 'ProfileCurrentSecret-React-101!'
      const profileResponse = await context.request.post('/settings/profile', {
        maxRedirects: 0,
        data: { fullName: 'Updated Name', currentPassword: [profileMarker] },
        headers: headersFor('/settings/profile'),
      })
      assert.equal(profileResponse.status(), 302)
      const profileFlash = await context.getFlashMessages()
      const profileSession = await context.getSession()
      assert.isArray(profileFlash.inputErrorsBag?.currentPassword)
      assert.deepEqual(oldInputFromFlash(profileFlash), { fullName: 'Updated Name' })
      assert.notInclude(JSON.stringify({ profileFlash, profileSession }), profileMarker)

      const passwordMarkers = {
        currentPassword: 'SettingsCurrentSecret-React-102!',
        password: 'SettingsNewSecret-React-103!',
        passwordConfirmation: 'SettingsConfirmSecret-React-104!',
      }
      const passwordResponse = await context.request.post('/settings/password', {
        maxRedirects: 0,
        form: passwordMarkers,
        headers: headersFor('/settings/password'),
      })
      assert.equal(passwordResponse.status(), 302)
      const passwordFlash = await context.getFlashMessages()
      const passwordSession = await context.getSession()
      assert.isArray(passwordFlash.inputErrorsBag?.passwordConfirmation)
      assert.deepEqual(oldInputFromFlash(passwordFlash), {})
      const persistedPasswordState = JSON.stringify({ passwordFlash, passwordSession })
      for (const marker of Object.values(passwordMarkers))
        assert.notInclude(persistedPasswordState, marker)

      const cancelMarker = 'CancelCurrentSecret-React-105!'
      const cancelResponse = await context.request.post('/settings/email/cancel', {
        maxRedirects: 0,
        data: { cancelCurrentPassword: [cancelMarker] },
        headers: headersFor('/settings/email'),
      })
      assert.equal(cancelResponse.status(), 302)
      const cancelFlash = await context.getFlashMessages()
      const cancelSession = await context.getSession()
      assert.isArray(cancelFlash.inputErrorsBag?.cancelCurrentPassword)
      assert.deepEqual(oldInputFromFlash(cancelFlash), {})
      assert.notInclude(JSON.stringify({ cancelFlash, cancelSession }), cancelMarker)

      const inertiaMarker = 'InertiaCurrentSecret-React-106!'
      const inertiaResponse = await context.request.post('/settings/profile', {
        maxRedirects: 0,
        data: { fullName: 'Inertia Name', currentPassword: [inertiaMarker] },
        headers: { ...headersFor('/settings/profile'), 'x-inertia': 'true' },
      })
      assert.equal(inertiaResponse.status(), 302)
      const inertiaFlash = await context.getFlashMessages()
      const inertiaSession = await context.getSession()
      assert.isArray(inertiaFlash.inputErrorsBag?.currentPassword)
      assert.deepEqual(oldInputFromFlash(inertiaFlash), {})
      assert.notInclude(JSON.stringify({ inertiaFlash, inertiaSession }), inertiaMarker)
    } finally {
      await context.close()
    }
  })
})
