import { test } from '@japa/runner'
import type { HttpContext, Router } from '@adonisjs/core/http'
import { AccountKit } from '../src/account_kit.js'
import { DeliveryError, InvalidSessionError } from '../src/errors.js'
import { registerManagedRoutes, type ManagedRoutesOptions } from '../src/http/managed.js'

function fixture() {
  const routes = new Map<string, (context: HttpContext) => Promise<unknown>>()
  const committed: Array<{ methods: string[]; pattern: string; name: string }> = []
  const pending: Array<{ methods: string[]; pattern: string; name: string }> = []
  let didCommit = false
  const router = {
    toJSON: () => ({ root: committed }),
    route(path: string, methods: string[], handler: (context: HttpContext) => Promise<unknown>) {
      routes.set(`${methods[0]} ${path}`, handler)
      const definition = { methods, pattern: path, name: '' }
      pending.push(definition)
      return {
        as(name: string) {
          definition.name = name
          return this
        },
      }
    },
    commit() {
      if (!didCommit) committed.push(...pending)
      didCommit = true
    },
  } as unknown as Router
  function context(params: Record<string, string> = {}) {
    const headers: Record<string, string> = {}
    const response = {
      header(name: string, value: string) {
        headers[name] = value
        return this
      },
      status(status: number) {
        return { send: (body: unknown) => ({ status, body }) }
      },
      ok(body: unknown) {
        return { status: 200, body }
      },
      accepted(body: unknown) {
        return { status: 202, body }
      },
      created(body: unknown) {
        return { status: 201, body }
      },
      noContent() {
        return { status: 204 }
      },
    }
    return {
      params,
      request: {
        ip: () => '192.0.2.1',
        header: () => undefined,
        validateUsing: async () => ({ email: 'a@example.test', password: 'password123' }),
      },
      response,
      headers,
    } as unknown as HttpContext & { headers: Record<string, string> }
  }
  return { router, routes, context, pending }
}

test.group('managed HTTP dispatch', () => {
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
  test('excludes a named route and rejects a second registration before mutating router', ({
    assert,
  }) => {
    const { router, routes } = fixture()
    const options = {
      prefix: '/api/v1',
      kit: async () => ({}) as AccountKit,
      guard: {
        strategy: 'session' as const,
        name: 'web',
        forRequest: () => ({}) as never,
        current: async () => ({ userId: 1, revision: null }),
      },
      enabled: ['authentication'] as const,
      except: ['auth.login'] as const,
    }
    registerManagedRoutes(router, options)
    assert.isFalse(routes.has('POST /api/v1/auth/login'))
    const count = routes.size
    assert.throws(() => registerManagedRoutes(router, options), /already registered/)
    assert.equal(routes.size, count)
  })

  test('a queued application collision aborts router commit before serving requests', ({
    assert,
  }) => {
    const { router, pending } = fixture()
    pending.push({ methods: ['POST'], pattern: '/api/v1/auth/login', name: 'application.login' })
    registerManagedRoutes(router, {
      prefix: '/api/v1',
      kit: async () => ({}) as AccountKit,
      guard: {
        strategy: 'session',
        name: 'web',
        forRequest: () => ({}) as never,
        current: async () => ({ userId: 1, revision: null }),
      },
      enabled: ['authentication'],
    })
    assert.throws(() => router.commit(), /POST \/api\/v1\/auth\/login.*application\.login/)
  })

  test('late application routes are checked and repeated commit stays stable', ({ assert }) => {
    const { router, pending, routes } = fixture()
    registerManagedRoutes(router, {
      prefix: '/api/v1',
      kit: async () => ({}) as AccountKit,
      guard: {
        strategy: 'session',
        name: 'web',
        forRequest: () => ({}) as never,
        current: async () => ({ userId: 1, revision: null }),
      },
      enabled: ['authentication'],
    })
    pending.push({ methods: ['POST'], pattern: '/api/v1/auth/login', name: 'late.login' })
    const count = routes.size
    assert.throws(() => router.commit(), /late\.login/)
    assert.throws(() => router.commit(), /late\.login/)
    assert.equal(routes.size, count)
  })

  test('collision check preserves router commit receiver, arguments, and result', ({ assert }) => {
    const { router } = fixture()
    const original = router.commit
    const sentinel = { committed: true }
    let called = false
    router.commit = function (this: Router, ...args: unknown[]) {
      assert.strictEqual(this, router)
      assert.deepEqual(args, ['test-argument'])
      original.call(this)
      called = true
      return sentinel as never
    } as Router['commit']
    registerManagedRoutes(router, {
      prefix: '/api/v1',
      kit: async () => ({}) as AccountKit,
      guard: {
        strategy: 'session',
        name: 'web',
        forRequest: () => ({}) as never,
        current: async () => ({ userId: 1, revision: null }),
      },
      enabled: ['authentication'],
    })
    assert.strictEqual(
      (router.commit as (...args: unknown[]) => unknown)('test-argument'),
      sentinel
    )
    assert.isTrue(called)
  })

  test('a protected route validates the selected guard evidence before revealing account data', async ({
    assert,
  }) => {
    const { router, routes, context } = fixture()
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
      guard: {
        strategy: 'session',
        name: 'web',
        forRequest: () => ({}) as never,
        async current() {
          currentCalled = true
          return { userId: 7, revision: 'trusted' }
        },
      },
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
    const { router, routes, context } = fixture()
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
      guard: {
        strategy: 'access_tokens',
        name: 'api',
        publicCredential: () => 'token',
        forRequest: () => ({}) as never,
        current: async () => {
          throw new InvalidSessionError()
        },
      },
      enabled: ['authentication'],
    })
    const output = await routes.get('GET /api/v1/account/profile')!(context())
    assert.isFalse(serviceCalled)
    assert.equal((output as { status: number }).status, 401)
  })

  test('token login returns only the opaque bearer value', async ({ assert }) => {
    const { router, routes, context } = fixture()
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
      guard: {
        strategy: 'access_tokens',
        name: 'api',
        publicCredential: (credential: { value: string }) => credential.value,
        forRequest: () => ({}) as never,
        current: async () => ({ userId: 7, tokenId: 42 }),
      },
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

  test('signup establishes the selected limited credential through authentication', async ({
    assert,
  }) => {
    const { router, routes, context } = fixture()
    const calls: string[] = []
    const credential = { userId: 7, identifier: 42, value: 'opaque' }
    registerManagedRoutes(router, {
      prefix: '/api/v1',
      kit: async () =>
        ({
          managedHttp: { assertGuard: () => {} },
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
      guard: {
        strategy: 'access_tokens',
        name: 'api',
        publicCredential: (value: typeof credential) => value.value,
        forRequest: () => ({}) as never,
        current: async () => ({ userId: 7, tokenId: 42 }),
      },
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
    const { router, routes, context } = fixture()
    registerManagedRoutes(router, {
      prefix: '/api/v1',
      kit: async () =>
        ({
          managedHttp: { assertGuard: () => {} },
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
      guard: {
        strategy: 'session',
        name: 'web',
        forRequest: () => ({}) as never,
        current: async () => ({ userId: 7, revision: null }),
      },
      enabled: ['registration'],
    })
    const ctx = context()
    Object.assign(ctx.request, { csrfToken: 'proof' })
    assert.deepEqual(await routes.get('POST /api/v1/auth/signup')!(ctx), {
      status: 201,
      body: { registered: true, authenticated: false },
    })
  })

  test('a representation failure does not falsely say signup authentication failed', async ({
    assert,
  }) => {
    const { router, routes, context } = fixture()
    registerManagedRoutes(router, {
      prefix: '/api/v1',
      kit: async () =>
        ({
          managedHttp: { assertGuard: () => {} },
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
      guard: {
        strategy: 'session',
        name: 'web',
        forRequest: () => ({}) as never,
        current: async () => ({ userId: 7, revision: null }),
      },
      enabled: ['registration'],
      extensions: {
        representAccount: () => {
          throw new Error('representation failed')
        },
      },
    })
    const ctx = context()
    Object.assign(ctx.request, { csrfToken: 'proof' })
    await assert.rejects(
      () => routes.get('POST /api/v1/auth/signup')!(ctx),
      /representation failed/
    )
  })

  test('session login fails closed without Shield CSRF state', async ({ assert }) => {
    const { router, routes, context } = fixture()
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
      guard: {
        strategy: 'session',
        name: 'web',
        forRequest: () => ({}) as never,
        current: async () => ({ userId: 1, revision: null }),
      },
      enabled: ['authentication'],
    })
    await assert.rejects(
      () => routes.get('POST /api/v1/auth/login')!(context()),
      /Shield CSRF middleware/
    )
    assert.isFalse(loggedIn)
  })

  test('GET proof inspection stays read-only and sets both protective headers', async ({
    assert,
  }) => {
    const { router, routes, context } = fixture()
    let inspected = 0
    let limited = 0
    const kit = {
      managedHttp: {
        assertGuard: () => {},
        consume: async () => {
          limited++
        },
      },
      passwordReset: {
        inspect: async () => {
          inspected++
          return true
        },
        reset: async () => {
          throw new Error('mutated')
        },
      },
    } as unknown as AccountKit
    registerManagedRoutes(router, {
      prefix: '/api/v1',
      kit: async () => kit,
      guard: {
        strategy: 'access_tokens',
        name: 'api',
        forRequest: () => ({}) as never,
        current: async () => ({ userId: 1, tokenId: 1 }),
      },
      enabled: ['passwordReset'],
    })
    const ctx = context({ token: 'proof' })
    const output = await routes.get('GET /api/v1/auth/password-reset/:token')!(ctx)
    assert.deepEqual(output, { status: 200, body: { valid: true } })
    assert.equal(inspected, 1)
    assert.equal(limited, 1)
    assert.deepEqual(ctx.headers, { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' })
  })

  test('post-commit notification failure remains a successful write response', async ({
    assert,
  }) => {
    const { router, routes, context } = fixture()
    const kit = {
      managedHttp: { assertGuard: () => {} },
      authentication: {
        current: async () => ({
          id: 1,
          email: 'a@example.test',
          unverifiedEmail: 'a@example.test',
          hasPassword: true,
          active: false,
        }),
      },
      emailVerification: {
        send: async () => {
          throw new DeliveryError('private mail failure')
        },
      },
    } as unknown as AccountKit
    registerManagedRoutes(router, {
      prefix: '/api/v1',
      kit: async () => kit,
      guard: {
        strategy: 'access_tokens',
        name: 'api',
        forRequest: () => ({}) as never,
        current: async () => ({ userId: 1, tokenId: 2 }),
      },
      enabled: ['emailVerification'],
    })
    const output = await routes.get('POST /api/v1/account/email-verification/send')!(context())
    assert.deepEqual(output, { status: 202, body: { committed: true } })
  })
})
