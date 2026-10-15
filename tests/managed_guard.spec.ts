import { test } from '@japa/runner'
import { InvalidSessionError } from '../src/errors.js'
import { createManagedGuard, managedAccountMiddleware } from '../src/http/guard.js'

test.group('managed existing-guard adapters', () => {
  test('session login regenerates, captures revision, and current reads only authenticated state', async ({
    assert,
  }) => {
    const actions: string[] = []
    const values = new Map<string, unknown>()
    const user = { id: 42 }
    const ctx = {
      auth: {
        use: (name: string) => {
          assert.equal(name, 'web')
          return {
            authenticate: async () => user,
            login: async () => {
              actions.push('login')
            },
            logout: async () => {
              actions.push('logout')
            },
          }
        },
      },
      session: {
        regenerate: () => {
          actions.push('regenerate')
        },
        put: (key: string, value: unknown) => {
          values.set(key, value)
        },
        get: (key: string) => values.get(key),
        clear: () => {
          actions.push('clear')
          values.clear()
        },
      },
    } as never
    const adapter = createManagedGuard({
      strategy: 'session',
      name: 'web',
      loadUser: async () => ({ findOrFail: async () => user }),
    })
    assert.deepEqual(await adapter.current(ctx), { userId: 42 })
    await adapter.forRequest(ctx).establish(42, 'revision-1')
    assert.deepEqual(await adapter.current(ctx), { userId: 42, revision: 'revision-1' })
    assert.deepEqual(actions.slice(0, 2), ['regenerate', 'login'])
    await adapter.forRequest(ctx).terminate()
    assert.deepEqual(actions.slice(-3), ['logout', 'clear', 'regenerate'])
  })

  test('token login returns only newly issued opaque token and logout deletes only current token', async ({
    assert,
  }) => {
    const deleted: unknown[] = []
    const user = { id: 'user-1', currentAccessToken: { identifier: 'token-1' } }
    const adapter = createManagedGuard({
      strategy: 'access_tokens',
      name: 'api',
      loadUser: async () => ({
        findOrFail: async () => user,
        accessTokens: {
          create: async () => ({ identifier: 'token-2', value: { release: () => 'secret-token' } }),
          delete: async (_user: unknown, identifier: unknown) => {
            deleted.push(identifier)
          },
        },
      }),
    })
    const ctx = { auth: { use: () => ({ authenticate: async () => user }) } } as never
    const credential = await adapter.forRequest(ctx).establish('user-1', ['*'], '1d')
    assert.deepEqual(credential, { userId: 'user-1', identifier: 'token-2', value: 'secret-token' })
    assert.deepEqual(await adapter.current(ctx), { userId: 'user-1', tokenId: 'token-1' })
    await adapter.forRequest(ctx).terminate(await adapter.logoutCredential(ctx))
    assert.deepEqual(deleted, ['token-1'])
  })

  test('missing current token fails before protected account work', async ({ assert }) => {
    const user = { id: 42 }
    const adapter = createManagedGuard({
      strategy: 'access_tokens',
      name: 'api',
      loadUser: async () => ({
        findOrFail: async () => user,
        accessTokens: {
          create: async () => ({ identifier: 1, value: { release: () => 'token' } }),
          delete: async () => {},
        },
      }),
    })
    const ctx = { auth: { use: () => ({ authenticate: async () => user }) } } as never
    await assert.rejects(() => adapter.current(ctx), InvalidSessionError)
  })

  test('selected guard rejection becomes one package 401 without losing operational failures', async ({
    assert,
  }) => {
    const adapter = createManagedGuard({
      strategy: 'session',
      name: 'web',
      loadUser: async () => ({ findOrFail: async () => ({ id: 1 }) }),
    })
    const unauthorised = Object.assign(new Error('private guard details'), {
      code: 'E_UNAUTHORIZED_ACCESS',
    })
    const ctx = {
      auth: {
        use: () => ({
          authenticate: async () => {
            throw unauthorised
          },
        }),
      },
    } as never
    await assert.rejects(() => adapter.current(ctx), InvalidSessionError)
    const databaseFailure = new Error('database offline')
    const outage = {
      auth: {
        use: () => ({
          authenticate: async () => {
            throw databaseFailure
          },
        }),
      },
    } as never
    await assert.rejects(() => adapter.current(outage), /database offline/)
  })

  test('application-owned route middleware enforces the same account revision gate', async ({
    assert,
  }) => {
    let next = false
    const handler = managedAccountMiddleware({
      kit: async () =>
        ({
          managedHttp: { assertGuard: () => {} },
          authentication: {
            requireActive: async (input: unknown) => {
              assert.deepEqual(input, { userId: 42, revision: 'stamp' })
            },
          },
        }) as never,
      guard: { current: async () => ({ userId: 42, revision: 'stamp' }) } as never,
      active: true,
    })
    await handler({} as never, async () => {
      next = true
    })
    assert.isTrue(next)
  })
})
