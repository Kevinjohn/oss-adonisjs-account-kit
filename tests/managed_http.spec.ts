import { test } from '@japa/runner'
import type { HttpContext, Router } from '@adonisjs/core/http'
import { AccountKit } from '../src/account_kit.js'
import { DeliveryError, InvalidSessionError, ThrottledError } from '../src/errors.js'
import { registerManagedRoutes, type ManagedRoutesOptions } from '../src/http/managed.js'
import type { ManagedQuery, ManagedSuccessBody } from '../src/http/contracts.js'
import { useTestApp } from './helpers/app.js'
import { insertUser, makeService } from './helpers/fakes.js'

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
      getHeader(name: string) {
        return headers[name]
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
      const { router, routes, context } = fixture()
      registerManagedRoutes(router, {
        prefix: '/api/v1',
        kit: async () => kit,
        guard: {
          strategy: 'access_tokens',
          name: 'api',
          forRequest: () => ({}) as never,
          current: async () => ({ userId: 7, tokenId: 11 }),
        },
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
    const { router, routes, context } = fixture()
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
      guard: {
        strategy: 'session',
        name: 'web',
        forRequest: () => ({}) as never,
        current: async () => ({ userId: 1, revision: null }),
      },
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
    const { router, routes, context } = fixture()
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
      guard: {
        strategy: 'session',
        name: 'web',
        forRequest: () => ({}) as never,
        current: async () => ({ userId: 1, revision: null }),
      },
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
    const { router, routes, context } = fixture()
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
      guard: {
        strategy: 'access_tokens',
        name: 'api',
        publicCredential: () => 'opaque',
        forRequest: () => ({}) as never,
        current: async () => ({ userId: 1, tokenId: 1 }),
      },
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

  test('session password login updates the visitor-local methods hint after credential establishment', async ({
    assert,
  }) => {
    const { router, routes, context } = fixture()
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
      guard: {
        strategy: 'session',
        name: 'web',
        forRequest: () => ({}) as never,
        current: async () => ({ userId: 7, revision: null }),
      },
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

  test('a committed social GET callback returns accepted when notification delivery fails', async ({
    assert,
  }) => {
    const { router, routes, context } = fixture()
    const kit = {
      managedHttp: { assertGuard: () => {}, consume: async () => {} },
      socialAuthentication: {
        callback: async () => {
          throw new DeliveryError('Notification failed after commit')
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
        current: async () => ({ userId: 7, tokenId: 11 }),
        publicCredential: () => 'opaque',
      },
      enabled: ['socialAuthentication'],
      extensions: { social: { providers: ['google'] } },
    })
    const ctx = context({ provider: 'google' })
    Object.assign(ctx.request, {
      input: (key: string) =>
        ({ state: 'valid-state', code: 'provider-code' })[key as 'state' | 'code'],
    })
    const output = await routes.get('GET /api/v1/auth/oauth/:provider/callback')!(ctx)
    assert.deepEqual(output, { status: 202, body: { committed: true } })
  })

  test('a committed social unlink returns typed accepted when notification delivery fails', async ({
    assert,
  }) => {
    const { router, routes, context } = fixture()
    const account = {
      id: 7,
      email: 'a@example.test',
      unverifiedEmail: null,
      hasPassword: true,
      active: true,
    }
    const kit = {
      managedHttp: { assertGuard: () => {}, consume: async () => {} },
      authentication: { current: async () => account },
      socialAuthentication: {
        unlink: async () => {
          throw new DeliveryError('Notification failed after unlink commit')
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
        current: async () => ({ userId: 7, tokenId: 11 }),
        publicCredential: () => 'opaque',
      },
      enabled: ['socialAuthentication'],
      extensions: { social: { providers: ['google'] } },
    })
    const ctx = context({ id: '1' })
    Object.assign(ctx.request, { validateUsing: async () => ({ proof: 'valid-proof' }) })
    const output = await routes.get('DELETE /api/v1/account/social-identities/:id')!(ctx)
    const body: ManagedSuccessBody<'account.socialIdentities.unlink'> = { committed: true }
    assert.deepEqual(output, { status: 202, body })
  })

  test('last-method writes run only when methods is mounted and cannot fail an issued login', async ({
    assert,
  }) => {
    for (const selection of ['password-only', 'methods-excluded', 'methods-enabled'] as const) {
      const { router, routes, context } = fixture()
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
        guard: {
          strategy: 'session',
          name: 'web',
          forRequest: () => ({}) as never,
          current: async () => ({ userId: 7, revision: null }),
        },
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
    const { router, routes, context } = fixture()
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

  test('all proof GET and POST routes consume the real managed budget and set protective headers', async ({
    assert,
  }) => {
    const { router, routes, context } = fixture()
    const keys: string[] = []
    const real = new AccountKit({
      config: {
        authentication: { guard: 'api', strategy: 'access_tokens' },
        throttle: { requests: 20, duration: '15m' },
        limiterSecret: 'a'.repeat(32),
        limiterNamespace: 'proof-test',
        passwordPolicy: {
          minLength: 8,
          maxLength: null,
          letters: false,
          mixedCase: false,
          numbers: false,
          symbols: false,
          minScore: 0,
        },
      },
      limiter: {
        use: () => ({
          consume: async (key: string) => {
            keys.push(key)
          },
        }),
      },
    } as never)
    const user = {
      id: 7,
      email: 'a@example.test',
      unverifiedEmail: null,
      hasPassword: true,
      emailVerifiedAt: null,
    }
    const kit = {
      managedHttp: real.managedHttp,
      passwordReset: { inspect: async () => true, reset: async () => {} },
      emailVerification: { inspect: async () => true, complete: async () => 'verified' },
      emailPasswordManagement: {
        inspectEmailChange: async () => true,
        completeEmailChange: async () => user,
      },
      invitations: {
        inspect: async () => ({ email: user.email, role: 'member' }),
        accept: async () => user,
      },
    } as unknown as AccountKit
    registerManagedRoutes(router, {
      prefix: '/api/v1',
      kit: async () => kit,
      guard: {
        strategy: 'access_tokens',
        name: 'api',
        forRequest: () => ({}) as never,
        current: async () => ({ userId: 7, tokenId: 1 }),
      },
      enabled: ['passwordReset', 'emailVerification', 'emailPasswordManagement', 'invitations'],
    })
    for (const path of [
      '/api/v1/auth/password-reset/:token',
      '/api/v1/auth/email-verification/:token',
      '/api/v1/auth/invitations/:token',
      '/api/v1/auth/email-change/:token',
    ]) {
      for (const method of ['GET', 'POST']) {
        const ctx = context({ token: 'proof' })
        await routes.get(`${method} ${path}`)!(ctx)
        assert.equal(ctx.headers['Cache-Control'], 'no-store')
        assert.equal(ctx.headers['Referrer-Policy'], 'no-referrer')
      }
    }
    assert.equal(keys.length, 8)
    assert.equal(new Set(keys).size, 8)
    assert.isTrue(keys.every((key) => !key.includes('192.0.2.1')))
  })

  test('account writes return only their documented response bodies', async ({ assert }) => {
    const { router, routes, context } = fixture()
    const account = {
      id: 7,
      email: 'a@example.test',
      unverifiedEmail: null,
      hasPassword: true,
      active: true,
    }
    const user = { ...account, emailVerifiedAt: null, passwordHash: 'never expose' }
    const kit = {
      managedHttp: { assertGuard: () => {}, consume: async () => {}, passwordAllowed: () => true },
      authentication: {
        current: async () => account,
        requireActive: async () => account,
        logout: async () => {},
      },
      emailPasswordManagement: {
        updateProfile: async () => user,
        changePassword: async () => {},
      },
      emailVerification: { send: async () => 'sent' },
      invitations: {
        send: async () => ({ id: 2 }),
        list: async () => ({ items: [], nextCursor: null }),
        resend: async () => ({ id: 2 }),
        revoke: async () => {},
      },
    } as unknown as AccountKit
    registerManagedRoutes(router, {
      prefix: '/api/v1',
      kit: async () => kit,
      guard: {
        strategy: 'access_tokens',
        name: 'api',
        publicCredential: () => 'opaque',
        forRequest: () => ({}) as never,
        current: async () => ({ userId: 7, tokenId: 11 }),
        logoutCredential: async () => ({ userId: 7, identifier: 11 }),
      },
      enabled: ['authentication', 'emailPasswordManagement', 'emailVerification', 'invitations'],
    })
    const expected: Array<[string, number, unknown]> = [
      ['POST /api/v1/account/logout', 204, undefined],
      ['PATCH /api/v1/account/profile', 200, { account }],
      ['POST /api/v1/account/password', 200, { changed: true }],
      ['POST /api/v1/account/email-verification/send', 200, { result: 'sent' }],
      ['POST /api/v1/account/invitations', 201, { id: 2 }],
      ['GET /api/v1/account/invitations', 200, { items: [], nextCursor: null }],
      ['POST /api/v1/account/invitations/:id/resend', 200, { id: 2 }],
      ['DELETE /api/v1/account/invitations/:id', 204, undefined],
    ]
    for (const [route, status, body] of expected) {
      const output = await routes.get(route)!(context({ id: '2' }))
      assert.equal((output as { status: number }).status, status)
      assert.deepEqual((output as { body?: unknown }).body, body)
    }
  })

  test('representation failures preserve committed invitation, email, and profile responses', async ({
    assert,
  }) => {
    const { router, routes, context } = fixture()
    const user = {
      id: 7,
      email: 'a@example.test',
      unverifiedEmail: null,
      hasPassword: true,
      emailVerifiedAt: null,
      passwordHash: 'private',
    }
    const account = {
      id: 7,
      email: user.email,
      unverifiedEmail: null,
      hasPassword: true,
      active: true,
    }
    const kit = {
      managedHttp: { assertGuard: () => {}, consume: async () => {}, passwordAllowed: () => true },
      authentication: { current: async () => account },
      invitations: { accept: async () => user },
      emailPasswordManagement: {
        completeEmailChange: async () => user,
        updateProfile: async () => user,
      },
    } as unknown as AccountKit
    registerManagedRoutes(router, {
      prefix: '/api/v1',
      kit: async () => kit,
      guard: {
        strategy: 'access_tokens',
        name: 'api',
        forRequest: () => ({}) as never,
        current: async () => ({ userId: 7, tokenId: 11 }),
      },
      enabled: ['invitations', 'emailPasswordManagement'],
      extensions: {
        representAccount: async () => {
          throw new Error('private rendering failure')
        },
      },
    })
    for (const [path, status] of [
      ['POST /api/v1/auth/invitations/:token', 201],
      ['POST /api/v1/auth/email-change/:token', 200],
      ['PATCH /api/v1/account/profile', 200],
    ] as const) {
      const diagnostics: unknown[] = []
      const ctx = context({ token: 'secret-proof' })
      Object.assign(ctx, {
        logger: { warn: (data: unknown) => diagnostics.push(data) },
      })
      const output = await routes.get(path)!(ctx)
      assert.deepEqual(output, { status, body: { account } })
      assert.deepEqual(diagnostics, [
        {
          operation: path.includes('invitations')
            ? 'auth.invitation.accept'
            : path.includes('email-change')
              ? 'auth.emailChange.complete'
              : 'account.profile.update',
          outcome: 'representation_failed',
        },
      ])
    }
  })

  test('sensitive account routes forward a purpose-bound proof to shared services', async ({
    assert,
  }) => {
    const { router, routes, context } = fixture()
    const account = {
      id: 7,
      email: 'a@example.test',
      unverifiedEmail: null,
      hasPassword: false,
      active: true,
    }
    const calls: Array<{ operation: string; input: unknown }> = []
    const kit = {
      managedHttp: { assertGuard: () => {}, consume: async () => {}, passwordAllowed: () => true },
      authentication: {
        current: async () => account,
        requireActive: async () => account,
      },
      emailPasswordManagement: {
        changePassword: async (input: unknown) => calls.push({ operation: 'password', input }),
        updateProfile: async (input: unknown) => {
          calls.push({ operation: 'profile', input })
          return account
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
        current: async () => ({ userId: 7, tokenId: 11 }),
      },
      enabled: ['emailPasswordManagement'],
    })
    const password = context()
    Object.assign(password.request, {
      validateUsing: async () => ({ newPassword: 'new-password', recentProof: 'password-proof' }),
    })
    await routes.get('POST /api/v1/account/password')!(password)
    const profile = context()
    Object.assign(profile.request, {
      validateUsing: async () => ({ email: 'new@example.test', recentProof: 'email-proof' }),
    })
    await routes.get('PATCH /api/v1/account/profile')!(profile)
    assert.deepEqual(calls, [
      {
        operation: 'password',
        input: {
          actorId: 7,
          currentPassword: undefined,
          recentProof: 'password-proof',
          newPassword: 'new-password',
        },
      },
      {
        operation: 'profile',
        input: {
          actorId: 7,
          currentPassword: undefined,
          recentProof: 'email-proof',
          email: 'new@example.test',
        },
      },
    ])
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
    const ctx = context()
    const diagnostics: unknown[] = []
    Object.assign(ctx, { logger: { warn: (data: unknown) => diagnostics.push(data) } })
    const output = await routes.get('POST /api/v1/account/email-verification/send')!(ctx)
    const committed: ManagedSuccessBody<'account.emailVerification.send'> = { committed: true }
    assert.deepEqual(output, { status: 202, body: committed })
    assert.deepEqual(diagnostics, [
      { operation: 'account.emailVerification.send', outcome: 'delivery_failed' },
    ])
  })

  test('password-reset delivery failure retains its public acknowledgement and sanitized diagnostic', async ({
    assert,
  }) => {
    const { router, routes, context } = fixture()
    registerManagedRoutes(router, {
      prefix: '/api/v1',
      kit: async () =>
        ({
          managedHttp: { assertGuard: () => {} },
          passwordReset: {
            request: async () => {
              throw new DeliveryError('private delivery detail')
            },
          },
        }) as unknown as AccountKit,
      guard: {
        strategy: 'access_tokens',
        name: 'api',
        forRequest: () => ({}) as never,
        current: async () => ({ userId: 1, tokenId: 2 }),
      },
      enabled: ['passwordReset'],
    })
    const diagnostics: unknown[] = []
    const ctx = context()
    Object.assign(ctx, { logger: { warn: (data: unknown) => diagnostics.push(data) } })
    assert.deepEqual(await routes.get('POST /api/v1/auth/password-reset')!(ctx), {
      status: 202,
      body: { message: 'If the account exists, instructions will be sent.' },
    })
    assert.deepEqual(diagnostics, [
      { operation: 'auth.passwordReset.request', outcome: 'delivery_failed' },
    ])
  })

  test('invitation query contract is separate from its empty request body', ({ assert }) => {
    const query: ManagedQuery<'account.invitation.list'> = { limit: 25, cursor: 'opaque' }
    assert.deepEqual(query, { limit: 25, cursor: 'opaque' })
  })

  test('social GET callback query contract represents success and provider denial', ({
    assert,
  }) => {
    const success: ManagedQuery<'auth.oauth.callback'> = {
      code: 'provider-code',
      state: 'bound-state',
    }
    const denial: ManagedQuery<'auth.oauth.callback'> = {
      error: 'access_denied',
      state: 'bound-state',
    }
    assert.deepEqual(success, { code: 'provider-code', state: 'bound-state' })
    assert.deepEqual(denial, { error: 'access_denied', state: 'bound-state' })
  })

  test('negotiated errors preserve an existing Vary value', async ({ assert }) => {
    const { router, routes, context } = fixture()
    registerManagedRoutes(router, {
      prefix: '/api/v1',
      kit: async () => ({ managedHttp: { assertGuard: () => {} } }) as unknown as AccountKit,
      guard: {
        strategy: 'access_tokens',
        name: 'api',
        forRequest: () => ({}) as never,
        current: async () => {
          throw new InvalidSessionError()
        },
      },
      enabled: ['invitations'],
    })
    const ctx = context()
    ctx.response.header('Vary', 'Origin')
    const output = await routes.get('GET /api/v1/account/invitations')!(ctx)
    assert.equal((output as { status: number }).status, 401)
    assert.equal(ctx.headers.Vary, 'Origin, Accept')
  })
})

test.group('managed HTTP verification policy with live account state', (group) => {
  const app = useTestApp(group)

  test('optional verification permits inactive access but rejects restricted and stale credentials', async ({
    assert,
  }) => {
    const user = await insertUser(app, { verified: false })
    const { account } = makeService(app, {
      authentication: {
        strategy: 'session',
        guard: 'web',
        canAccess: async (candidate, trx) => {
          const row = await trx
            .from('users')
            .select('disabled_at')
            .where('id', candidate.id)
            .first()
          return !row?.disabled_at
        },
      },
    })
    const { router, routes, context } = fixture()
    registerManagedRoutes(router, {
      prefix: '/api/v1',
      kit: async () => account,
      guard: {
        strategy: 'session',
        name: 'web',
        forRequest: () => ({}) as never,
        current: async () => ({ userId: user.id, revision: null }),
      },
      enabled: ['invitations'],
      verificationRequired: false,
    })
    const run = () => routes.get('GET /api/v1/account/invitations')!(context())
    assert.equal(((await run()) as { status: number }).status, 200)

    await app.db
      .from('users')
      .where('id', user.id)
      .update({ disabled_at: new Date().toISOString() })
    assert.equal(((await run()) as { status: number }).status, 401)

    await app.db.from('users').where('id', user.id).update({ disabled_at: null })
    await account.authentication.changeRestriction({ userId: user.id, change: async () => {} })
    assert.equal(((await run()) as { status: number }).status, 401)
  })

  test('email-only profile update omits registration data for a required field mapper', async ({
    assert,
  }) => {
    const user = await insertUser(app)
    let mapped = false
    const { account } = makeService(app, {
      authentication: { strategy: 'session', guard: 'web' },
      registration: {
        availability: 'open',
        mapFields: async () => {
          mapped = true
          throw new Error('fullName is required')
        },
      },
    })
    const { router, routes, context } = fixture()
    registerManagedRoutes(router, {
      prefix: '/api/v1',
      kit: async () => account,
      guard: {
        strategy: 'session',
        name: 'web',
        forRequest: () => ({}) as never,
        current: async () => ({ userId: user.id, revision: null }),
      },
      enabled: ['emailPasswordManagement'],
    })
    const profile = routes.get('PATCH /api/v1/account/profile')!
    const ctx = context()
    Object.assign(ctx.request, {
      csrfToken: 'proof',
      validateUsing: async () => ({ currentPassword: 'password123', email: 'new@example.test' }),
    })
    assert.equal(((await profile(ctx)) as { status: number }).status, 200)
    assert.isFalse(mapped)

    const empty = context()
    Object.assign(empty.request, {
      csrfToken: 'proof',
      validateUsing: async () => ({ currentPassword: 'password123' }),
    })
    assert.equal(((await profile(empty)) as { status: number }).status, 422)
    assert.isFalse(mapped)
  })

  test('wrong current password has an identity-proof error on profile and password writes', async ({
    assert,
  }) => {
    const user = await insertUser(app)
    const { account } = makeService(app, {
      authentication: { strategy: 'session', guard: 'web' },
    })
    const { router, routes, context } = fixture()
    registerManagedRoutes(router, {
      prefix: '/api/v1',
      kit: async () => account,
      guard: {
        strategy: 'session',
        name: 'web',
        forRequest: () => ({}) as never,
        current: async () => ({ userId: user.id, revision: null }),
      },
      enabled: ['emailPasswordManagement'],
    })
    for (const [path, input] of [
      ['PATCH /api/v1/account/profile', { currentPassword: 'wrong', email: 'new@example.test' }],
      [
        'POST /api/v1/account/password',
        { currentPassword: 'wrong', newPassword: 'new-password123' },
      ],
    ] as const) {
      const ctx = context()
      Object.assign(ctx.request, { csrfToken: 'proof', validateUsing: async () => input })
      const output = await routes.get(path)!(ctx)
      assert.equal((output as { status: number }).status, 403)
      assert.deepEqual((output as { body: unknown }).body, {
        errors: [
          {
            code: 'E_ACCOUNT_KIT_IDENTITY_NOT_CONFIRMED',
            message: 'Current identity proof could not be confirmed.',
          },
        ],
      })
    }
  })
})
