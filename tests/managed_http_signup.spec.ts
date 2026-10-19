import { test } from '@japa/runner'
import { AccountKit } from '../src/account_kit.js'
import { DeliveryError, ThrottledError } from '../src/errors.js'
import { registerManagedRoutes } from '../src/http/managed.js'
import { fakeManagedHttp, stubGuard } from './helpers/managed_http_fakes.js'

test.group('managed HTTP dispatch', () => {
  test('public registration is allowed only by shared open availability', ({ assert }) => {
    for (const availability of ['closed', 'application'] as const) {
      const kit = new AccountKit({ config: { registration: { availability } } } as never)
      assert.throws(
        () => kit.managedHttp.assertPublicRegistration(),
        /Public registration is unavailable/
      )
    }
    const open = new AccountKit({ config: { registration: { availability: 'open' } } } as never)
    assert.doesNotThrow(() => open.managedHttp.assertPublicRegistration())
  })

  test('application-owned registration never reaches the managed signup service', async ({
    assert,
  }) => {
    const { router, routes, context } = fakeManagedHttp()
    let created = false
    const kit = new AccountKit({
      config: {
        registration: { availability: 'application' },
        authentication: { guard: 'web', strategy: 'session' },
      },
    } as never)
    registerManagedRoutes(router, {
      prefix: '/api/v1',
      kit: async () =>
        ({
          managedHttp: { ...kit.managedHttp, consume: async () => {} },
          registration: {
            register: async () => {
              created = true
            },
          },
        }) as unknown as AccountKit,
      guard: stubGuard(),
      enabled: ['registration'],
    })
    const ctx = context()
    Object.assign(ctx.request, { csrfToken: 'proof' })
    const output = await routes.get('POST /api/v1/auth/signup')!(ctx)
    assert.equal((output as { status: number }).status, 403)
    assert.isFalse(created)
  })

  test('the managed budget is shared and secret-keyed across service instances', async ({
    assert,
  }) => {
    const seen = new Map<string, number>()
    const limiter = {
      use: () => ({
        consume: async (key: string) => {
          assert.notInclude(key, '192.0.2.1')
          const count = (seen.get(key) ?? 0) + 1
          seen.set(key, count)
          if (count > 1) throw new ThrottledError(15)
        },
      }),
    }
    const deps = {
      config: {
        throttle: { requests: 1, duration: '15m' },
        limiterSecret: 'a'.repeat(32),
        limiterNamespace: 'managed-test',
      },
      limiter,
    }
    const first = new AccountKit(deps as never)
    const second = new AccountKit(deps as never)
    await first.managedHttp.consume({ endpoint: 'auth.signup', clientKey: '192.0.2.1' })
    await assert.rejects(
      () => second.managedHttp.consume({ endpoint: 'auth.signup', clientKey: '192.0.2.1' }),
      ThrottledError
    )
    await second.managedHttp.consume({
      endpoint: 'auth.passwordReset.inspect',
      clientKey: '192.0.2.1',
    })
    assert.equal(seen.size, 2)
  })

  test('signup exhaustion rejects before account creation', async ({ assert }) => {
    const { router, routes, context } = fakeManagedHttp()
    let created = false
    registerManagedRoutes(router, {
      prefix: '/api/v1',
      kit: async () =>
        ({
          managedHttp: {
            assertGuard: () => {},
            assertPublicRegistration: () => {},
            passwordAllowed: () => true,
            consume: async () => {
              throw new ThrottledError(12)
            },
          },
          registration: {
            register: async () => {
              created = true
            },
          },
        }) as unknown as AccountKit,
      guard: stubGuard(),
      enabled: ['registration'],
    })
    const ctx = context()
    Object.assign(ctx.request, { csrfToken: 'proof' })
    const output = await routes.get('POST /api/v1/auth/signup')!(ctx)
    assert.equal((output as { status: number }).status, 429)
    assert.isFalse(created)
  })

  test('shared configured password policy produces native field errors before a write', async ({
    assert,
  }) => {
    const { router, routes, context } = fakeManagedHttp()
    const writes: string[] = []
    const real = new AccountKit({
      config: {
        registration: { availability: 'open' },
        authentication: { guard: 'api', strategy: 'access_tokens' },
        passwordPolicy: {
          minLength: 8,
          maxLength: null,
          letters: false,
          mixedCase: true,
          numbers: false,
          symbols: false,
          minScore: 0,
        },
      },
    } as never)
    registerManagedRoutes(router, {
      prefix: '/api/v1',
      kit: async () =>
        ({
          managedHttp: { ...real.managedHttp, consume: async () => {} },
          registration: {
            register: async () => {
              writes.push('registration')
            },
          },
          passwordReset: {
            reset: async () => {
              writes.push('reset')
            },
          },
        }) as unknown as AccountKit,
      guard: stubGuard({
        strategy: 'access_tokens',
        publicCredential: () => 'opaque',
        current: async () => ({ userId: 1, tokenId: 1 }),
      }),
      enabled: ['registration', 'passwordReset'],
    })
    for (const route of ['POST /api/v1/auth/signup', 'POST /api/v1/auth/password-reset/:token']) {
      const output = await routes.get(route)!(context({ token: 'proof' }))
      assert.deepEqual(output, {
        status: 422,
        body: {
          errors: [
            {
              field: 'password',
              rule: 'passwordPolicy',
              message: 'Password does not meet the policy.',
            },
          ],
        },
      })
    }
    assert.deepEqual(writes, [])
  })

  test('signup establishes the selected limited credential through authentication', async ({
    assert,
  }) => {
    const { router, routes, context } = fakeManagedHttp()
    const calls: string[] = []
    const credential = { userId: 7, identifier: 42, value: 'opaque' }
    registerManagedRoutes(router, {
      prefix: '/api/v1',
      kit: async () =>
        ({
          managedHttp: {
            assertGuard: () => {},
            assertPublicRegistration: () => {},
            passwordAllowed: () => true,
            consume: async () => {},
          },
          registration: {
            register: async () => {
              calls.push('register')
            },
          },
          authentication: {
            login: async () => {
              calls.push('login')
              return {
                account: {
                  id: 7,
                  email: 'a@example.test',
                  unverifiedEmail: 'a@example.test',
                  hasPassword: true,
                  active: false,
                },
                credential,
              }
            },
          },
        }) as unknown as AccountKit,
      guard: stubGuard({
        strategy: 'access_tokens',
        publicCredential: (value: typeof credential) => value.value,
        current: async () => ({ userId: 7, tokenId: 42 }),
      }),
      enabled: ['registration'],
    })
    assert.deepEqual(await routes.get('POST /api/v1/auth/signup')!(context()), {
      status: 201,
      body: {
        account: {
          id: 7,
          email: 'a@example.test',
          unverifiedEmail: 'a@example.test',
          hasPassword: true,
          active: false,
        },
        token: 'opaque',
      },
    })
    assert.deepEqual(calls, ['register', 'login'])
  })

  test('a committed signup remains created when follow-up authentication fails', async ({
    assert,
  }) => {
    const { router, routes, context } = fakeManagedHttp()
    registerManagedRoutes(router, {
      prefix: '/api/v1',
      kit: async () =>
        ({
          managedHttp: {
            assertGuard: () => {},
            assertPublicRegistration: () => {},
            passwordAllowed: () => true,
            consume: async () => {},
          },
          registration: {
            register: async () => {
              throw new DeliveryError('mail unavailable')
            },
          },
          authentication: {
            login: async () => {
              throw new Error('authentication unavailable')
            },
          },
        }) as unknown as AccountKit,
      guard: stubGuard({
        current: async () => ({ userId: 7, revision: null }),
      }),
      enabled: ['registration'],
    })
    const ctx = context()
    Object.assign(ctx.request, { csrfToken: 'proof' })
    const diagnostics: unknown[] = []
    Object.assign(ctx, { logger: { warn: (data: unknown) => diagnostics.push(data) } })
    assert.deepEqual(await routes.get('POST /api/v1/auth/signup')!(ctx), {
      status: 201,
      body: { registered: true, authenticated: false },
    })
    assert.deepEqual(diagnostics, [
      { operation: 'auth.signup', outcome: 'delivery_failed' },
      { operation: 'auth.signup', outcome: 'authentication_failed' },
    ])
  })

  test('a representation failure does not falsely say signup authentication failed', async ({
    assert,
  }) => {
    const { router, routes, context } = fakeManagedHttp()
    registerManagedRoutes(router, {
      prefix: '/api/v1',
      kit: async () =>
        ({
          managedHttp: {
            assertGuard: () => {},
            assertPublicRegistration: () => {},
            passwordAllowed: () => true,
            consume: async () => {},
          },
          registration: { register: async () => {} },
          authentication: {
            login: async () => ({
              account: {
                id: 7,
                email: 'a@example.test',
                unverifiedEmail: 'a@example.test',
                hasPassword: true,
                active: false,
              },
              credential: undefined,
            }),
          },
        }) as unknown as AccountKit,
      guard: stubGuard({
        current: async () => ({ userId: 7, revision: null }),
      }),
      enabled: ['registration'],
      extensions: {
        representAccount: () => {
          throw new Error('representation failed')
        },
      },
    })
    const ctx = context()
    Object.assign(ctx.request, { csrfToken: 'proof' })
    const logged: unknown[] = []
    Object.assign(ctx, { logger: { warn: (data: unknown) => logged.push(data) } })
    assert.deepEqual(await routes.get('POST /api/v1/auth/signup')!(ctx), {
      status: 201,
      body: {
        account: {
          id: 7,
          email: 'a@example.test',
          unverifiedEmail: 'a@example.test',
          hasPassword: true,
          active: false,
        },
      },
    })
    assert.deepEqual(logged, [{ operation: 'auth.signup', outcome: 'representation_failed' }])
  })
})
