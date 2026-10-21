import { test } from '@japa/runner'
import type { HttpContext } from '@adonisjs/core/http'
import { DeliveryError, InvalidInputError, PostCommitError } from 'adonisjs-account-kit'
import kit from 'adonisjs-account-kit/services/main'
import NewAccountController from '#controllers/new_account_controller'

type Route = 'dashboard' | 'session.create'

function makeContext() {
  const flashes: Array<[string, string]> = []
  const routes: Route[] = []
  const loggedErrors: unknown[] = []
  const ctx = {
    request: {
      async validateUsing() {
        return {
          fullName: 'Signup Test',
          email: 'signup@example.test',
          password: 'SignupPass123!',
        }
      },
      ip: () => '127.0.0.1',
    },
    response: {
      redirect: () => ({
        toRoute(route: Route) {
          routes.push(route)
          return route
        },
      }),
    },
    auth: { use: () => ({}) },
    session: {
      flash: (key: string, value: string) => flashes.push([key, value]),
      regenerate() {},
      put() {},
    },
    logger: { error: (...args: unknown[]) => loggedErrors.push(args) },
  } as unknown as HttpContext

  return { ctx, flashes, routes, loggedErrors }
}

function replaceMethod(target: object, key: string, value: unknown) {
  const original = Object.getOwnPropertyDescriptor(target, key)
  Object.defineProperty(target, key, { configurable: true, writable: true, value })
  return () => {
    if (original) Object.defineProperty(target, key, original)
    else Reflect.deleteProperty(target, key)
  }
}

test.group('Signup recovery', () => {
  test('keeps a committed account and offers verification resend after delivery fails', async ({
    assert,
  }) => {
    const { ctx, flashes, routes, loggedErrors } = makeContext()
    let registered = false
    let loggedIn = false
    const restoreRegistration = replaceMethod(kit.registration, 'register', async () => {
      registered = true
      throw new DeliveryError('private mail transport detail')
    })
    const restoreAuthentication = replaceMethod(kit, 'authentication', {
      login: async () => {
        loggedIn = true
      },
    })

    try {
      await new NewAccountController().store(ctx)
    } finally {
      restoreRegistration()
      restoreAuthentication()
    }

    assert.isTrue(registered)
    assert.isTrue(loggedIn)
    assert.deepEqual(routes, ['dashboard'])
    assert.equal(flashes.length, 1)
    assert.include(flashes[0]![1], 'account was created')
    assert.include(flashes[0]![1], 'resend')
    assert.notInclude(flashes[0]![1], 'private mail transport detail')
    assert.lengthOf(loggedErrors, 1)
  })

  test('does not claim account creation when registration fails before commit', async ({
    assert,
  }) => {
    const { ctx, flashes, routes } = makeContext()
    let loggedIn = false
    const restoreRegistration = replaceMethod(kit.registration, 'register', async () => {
      throw new InvalidInputError('Registration was rejected')
    })
    const restoreAuthentication = replaceMethod(kit, 'authentication', {
      login: async () => {
        loggedIn = true
      },
    })

    try {
      await assert.rejects(() => new NewAccountController().store(ctx))
    } finally {
      restoreRegistration()
      restoreAuthentication()
    }

    assert.isFalse(loggedIn)
    assert.deepEqual(flashes, [])
    assert.deepEqual(routes, [])
  })

  test('does not claim email delivery failed when a post-commit observer fails', async ({
    assert,
  }) => {
    const { ctx, flashes, routes } = makeContext()
    const restoreRegistration = replaceMethod(kit.registration, 'register', async () => {
      throw new PostCommitError('private observer detail')
    })
    const restoreAuthentication = replaceMethod(kit, 'authentication', {
      login: async () => {},
    })

    try {
      await new NewAccountController().store(ctx)
    } finally {
      restoreRegistration()
      restoreAuthentication()
    }

    assert.deepEqual(routes, ['dashboard'])
    assert.include(flashes[0]![1], 'account was created')
    assert.include(flashes[0]![1], 'could not confirm that the verification email was sent')
    assert.notInclude(flashes[0]![1], 'private observer detail')
  })

  test('preserves the account and directs the user to sign in if session login fails', async ({
    assert,
  }) => {
    const { ctx, flashes, routes, loggedErrors } = makeContext()
    let registered = false
    const restoreRegistration = replaceMethod(kit.registration, 'register', async () => {
      registered = true
      return {} as never
    })
    const restoreAuthentication = replaceMethod(kit, 'authentication', {
      login: async () => {
        throw new Error('private session storage detail')
      },
    })

    try {
      await new NewAccountController().store(ctx)
    } finally {
      restoreRegistration()
      restoreAuthentication()
    }

    assert.isTrue(registered)
    assert.deepEqual(routes, ['session.create'])
    assert.equal(flashes.length, 1)
    assert.include(flashes[0]![1], 'account was created')
    assert.include(flashes[0]![1], 'sign in')
    assert.notInclude(flashes[0]![1], 'private session storage detail')
    assert.lengthOf(loggedErrors, 1)
  })
})
