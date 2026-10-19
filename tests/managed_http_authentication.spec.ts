import { test } from '@japa/runner'
import type { HttpContext } from '@adonisjs/core/http'
import { AccountKit } from '../src/account_kit.js'
import { InvalidSessionError } from '../src/errors.js'
import { registerManagedRoutes, type ManagedRoutesOptions } from '../src/http/managed.js'
import { fakeManagedHttp, stubGuard } from './helpers/managed_http_fakes.js'

test.group('managed HTTP dispatch', () => {
  test('verification policy can allow inactive accounts while retaining current-account checks', async ({
    assert,
  }) => {
    const account = {
      id: 7,
      email: 'a@example.test',
      unverifiedEmail: 'a@example.test',
      hasPassword: true,
      active: false,
    }
    const inputs: unknown[] = []
    const kit = {
      managedHttp: { assertGuard: () => {}, consume: async () => {} },
      authentication: {
        current: async (input: unknown) => {
          inputs.push(input)
          return account
        },
        requireActive: async () => {
          throw new Error('verification required')
        },
      },
      invitations: { send: async () => ({ id: 5 }) },
    } as unknown as AccountKit
    for (const verificationRequired of [undefined, false]) {
      const { router, routes, context } = fakeManagedHttp()
      registerManagedRoutes(router, {
        prefix: '/api/v1',
        kit: async () => kit,
        guard: stubGuard({
          strategy: 'access_tokens',
          current: async () => ({ userId: 7, tokenId: 11 }),
        }),
        enabled: ['invitations'],
        verificationRequired,
      })
      const run = () => routes.get('POST /api/v1/account/invitations')!(context())
      if (verificationRequired === false) {
        assert.deepEqual(await run(), { status: 201, body: { id: 5 } })
        assert.deepEqual(inputs.pop(), { userId: 7, tokenId: 11 })
      } else {
        await assert.rejects(run, /verification required/)
      }
    }
  })

  test('rejects a different named guard even when its strategy matches', ({ assert }) => {
    const kit = new AccountKit({
      config: { authentication: { guard: 'web', strategy: 'session' } },
    } as never)
    assert.doesNotThrow(() => kit.managedHttp.assertGuard({ name: 'web', strategy: 'session' }))
    assert.throws(
      () => kit.managedHttp.assertGuard({ name: 'other', strategy: 'session' }),
      /configured existing authentication guard/
    )
    assert.throws(
      () => kit.managedHttp.assertGuard({ name: 'web', strategy: 'access_tokens' }),
      /configured existing authentication guard/
    )
  })

  test('the session CSRF bootstrap response is never cacheable', async ({ assert }) => {
    const { router, routes, context } = fakeManagedHttp()
    const kit = new AccountKit({
      config: {
        registration: { availability: 'open' },
        authentication: { guard: 'web', strategy: 'session' },
      },
    } as never)
    registerManagedRoutes(router, {
      prefix: '/api/v1',
      kit: async () => kit,
      guard: stubGuard(),
      enabled: ['passwordReset'],
    })
    const ctx = context()
    Object.assign(ctx.request, { csrfToken: 'session-secret' })
    const output = await routes.get('GET /api/v1/auth/csrf')!(ctx)
    assert.deepEqual(output, { status: 200, body: { csrfToken: 'session-secret' } })
    assert.equal(ctx.headers['Cache-Control'], 'no-store')
  })

  test('a protected route validates the selected guard evidence before revealing account data', async ({
    assert,
  }) => {
    const { router, routes, context } = fakeManagedHttp()
    let currentCalled = false
    const kit = {
      managedHttp: { assertGuard: () => {} },
      authentication: {
        current: async (input: unknown) => {
          assert.deepEqual(input, { userId: 7, revision: 'trusted' })
          return {
            id: 7,
            email: 'a@example.test',
            unverifiedEmail: null,
            hasPassword: true,
            active: true,
          }
        },
      },
    } as unknown as AccountKit
    registerManagedRoutes(router, {
      prefix: '/api/v1',
      kit: async () => kit,
      guard: stubGuard({
        async current() {
          currentCalled = true
          return { userId: 7, revision: 'trusted' }
        },
      }),
      enabled: ['authentication'],
    } satisfies ManagedRoutesOptions<never>)
    const output = await routes.get('GET /api/v1/account/profile')!(context())
    assert.isTrue(currentCalled)
    assert.deepEqual(output, {
      status: 200,
      body: {
        account: {
          id: 7,
          email: 'a@example.test',
          unverifiedEmail: null,
          hasPassword: true,
          active: true,
        },
      },
    })
  })

  test('missing guard evidence gives 401 without calling account services', async ({ assert }) => {
    const { router, routes, context } = fakeManagedHttp()
    let serviceCalled = false
    registerManagedRoutes(router, {
      prefix: '/api/v1',
      kit: async () =>
        ({
          managedHttp: { assertGuard: () => {} },
          authentication: {
            current: async () => {
              serviceCalled = true
            },
          },
        }) as unknown as AccountKit,
      guard: stubGuard({
        strategy: 'access_tokens',
        publicCredential: () => 'token',
        current: async () => {
          throw new InvalidSessionError()
        },
      }),
      enabled: ['authentication'],
    })
    const output = await routes.get('GET /api/v1/account/profile')!(context())
    assert.isFalse(serviceCalled)
    assert.equal((output as { status: number }).status, 401)
  })

  test('token login returns only the opaque bearer value', async ({ assert }) => {
    const { router, routes, context } = fakeManagedHttp()
    registerManagedRoutes(router, {
      prefix: '/api/v1',
      kit: async () =>
        ({
          managedHttp: { assertGuard: () => {} },
          authentication: {
            login: async () => ({
              account: {
                id: 7,
                email: 'a@example.test',
                unverifiedEmail: null,
                hasPassword: true,
                active: true,
              },
              credential: { userId: 7, identifier: 42, value: 'opaque' },
            }),
          },
        }) as unknown as AccountKit,
      guard: stubGuard({
        strategy: 'access_tokens',
        publicCredential: (credential: { value: string }) => credential.value,
        current: async () => ({ userId: 7, tokenId: 42 }),
      }),
      enabled: ['authentication'],
    })
    const output = await routes.get('POST /api/v1/auth/login')!(context())
    assert.deepEqual(output, {
      status: 200,
      body: {
        account: {
          id: 7,
          email: 'a@example.test',
          unverifiedEmail: null,
          hasPassword: true,
          active: true,
        },
        token: 'opaque',
      },
    })
  })

  test('session password login updates the visitor-local methods hint after credential establishment', async ({
    assert,
  }) => {
    const { router, routes, context } = fakeManagedHttp()
    const kit = {
      managedHttp: { assertGuard: () => {} },
      authentication: {
        login: async () => ({
          account: {
            id: 7,
            email: 'a@example.test',
            unverifiedEmail: null,
            hasPassword: true,
            active: true,
          },
          credential: {},
        }),
      },
      socialAuthentication: {},
    } as unknown as AccountKit
    registerManagedRoutes(router, {
      prefix: '/api/v1',
      kit: async () => kit,
      guard: stubGuard({
        current: async () => ({ userId: 7, revision: null }),
      }),
      enabled: ['authentication', 'socialAuthentication'],
      extensions: { social: { providers: ['google'] } },
    })
    const values = new Map<string, unknown>()
    const ctx = context()
    ;(ctx as unknown as HttpContext & { session: unknown }).session = {
      get: (key: string) => values.get(key),
      put: (key: string, value: unknown) => values.set(key, value),
      forget: (key: string) => values.delete(key),
    }
    ;(ctx.request as typeof ctx.request & { csrfToken: string }).csrfToken = 'trusted-csrf'
    await routes.get('POST /api/v1/auth/login')!(ctx)
    assert.deepEqual(await routes.get('GET /api/v1/auth/methods')!(ctx), {
      status: 200,
      body: { providers: ['google'], lastUsedMethod: 'password' },
    })
  })

  test('last-method writes run only when methods is mounted and cannot fail an issued login', async ({
    assert,
  }) => {
    for (const selection of ['password-only', 'methods-excluded', 'methods-enabled'] as const) {
      const { router, routes, context } = fakeManagedHttp()
      let hintWrites = 0
      const account = {
        id: 7,
        email: 'a@example.test',
        unverifiedEmail: null,
        hasPassword: true,
        active: true,
      }
      const kit = {
        managedHttp: { assertGuard: () => {} },
        authentication: { login: async () => ({ account, credential: {} }) },
      } as unknown as AccountKit
      registerManagedRoutes(router, {
        prefix: '/api/v1',
        kit: async () => kit,
        guard: stubGuard({
          current: async () => ({ userId: 7, revision: null }),
        }),
        enabled:
          selection === 'password-only'
            ? ['authentication']
            : ['authentication', 'socialAuthentication'],
        except: selection === 'methods-excluded' ? ['auth.methods'] : [],
        extensions: {
          social: {
            providers: ['google'],
            rememberLastUsedMethod: async () => {
              hintWrites++
              throw new Error('cookie write failed')
            },
          },
        },
      })
      const ctx = context()
      ;(ctx.request as typeof ctx.request & { csrfToken: string }).csrfToken = 'trusted-csrf'
      ;(ctx as unknown as HttpContext & { session: unknown }).session = {
        get: () => null,
        put: () => {
          hintWrites++
          throw new Error('session write failed')
        },
        forget: () => {},
      }
      const result = await routes.get('POST /api/v1/auth/login')!(ctx)
      assert.equal((result as { status: number }).status, 200)
      assert.equal(hintWrites, selection === 'methods-enabled' ? 1 : 0)
    }
  })

  test('session login fails closed without Shield CSRF state', async ({ assert }) => {
    const { router, routes, context } = fakeManagedHttp()
    let loggedIn = false
    registerManagedRoutes(router, {
      prefix: '/api/v1',
      kit: async () =>
        ({
          authentication: {
            login: async () => {
              loggedIn = true
            },
          },
        }) as unknown as AccountKit,
      guard: stubGuard(),
      enabled: ['authentication'],
    })
    await assert.rejects(
      () => routes.get('POST /api/v1/auth/login')!(context()),
      /Shield CSRF middleware/
    )
    assert.isFalse(loggedIn)
  })
})
