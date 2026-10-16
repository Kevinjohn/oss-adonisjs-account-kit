import { test } from '@japa/runner'
import { InvalidSessionError } from '../src/errors.js'
import { createManagedGuard, managedAccountMiddleware } from '../src/http/guard.js'

class DatabaseStore {}
const serverSessionConfig = {
  store: 'browser',
  stores: { browser: () => new DatabaseStore() },
}

test.group('managed existing-guard adapters', () => {
  test('conventional model static types compile while invalid authenticated IDs fail closed', async ({
    assert,
  }) => {
    class LucidRow {
      static async findOrFail(_id: number | string): Promise<LucidRow> {
        return new User()
      }
    }
    class User extends LucidRow {
      id = 42
    }
    const adapter = createManagedGuard({
      strategy: 'session',
      name: 'web',
      loadUser: async () => User,
    })
    const ctx = {
      auth: { use: () => ({ authenticate: async () => ({}) }) },
      session: { config: serverSessionConfig, get: () => undefined },
    } as never
    await assert.rejects(() => adapter.current(ctx), InvalidSessionError)
  })
  test('reads Lucid proxy user and token IDs even when property membership is hidden', async ({
    assert,
  }) => {
    const user = new Proxy(
      {},
      {
        get(_target, key) {
          if (key === 'id') return 42
          if (key === 'currentAccessToken') return { identifier: 17 }
          return undefined
        },
        has: () => false,
      }
    )
    const ctx = {
      auth: { use: () => ({ authenticate: async () => user }) },
      session: { config: serverSessionConfig, get: () => '' },
    } as never
    const session = createManagedGuard({
      strategy: 'session',
      name: 'web',
      loadUser: async () => ({ findOrFail: async () => user }),
    })
    const token = createManagedGuard({
      strategy: 'access_tokens',
      name: 'api',
      loadUser: async () => ({
        findOrFail: async () => user,
        accessTokens: {
          create: async () => ({ identifier: 17, value: { release: () => 'token' } }),
          delete: async () => {},
        },
      }),
    })
    assert.deepEqual(await session.current(ctx), { userId: 42, revision: null })
    assert.deepEqual(await token.current(ctx), { userId: 42, tokenId: 17 })
  })
  test('normalizes Adonis bigint token identifiers at the service boundary', async ({ assert }) => {
    const user = { id: 42, currentAccessToken: { identifier: BigInt(17) } }
    const adapter = createManagedGuard({
      strategy: 'access_tokens',
      name: 'api',
      loadUser: async () => ({
        findOrFail: async () => user,
        accessTokens: {
          create: async () => ({ identifier: BigInt(18), value: { release: () => 'token' } }),
          delete: async () => {},
        },
      }),
    })
    const ctx = { auth: { use: () => ({ authenticate: async () => user }) } } as never
    assert.deepEqual(await adapter.current(ctx), { userId: 42, tokenId: '17' })
    assert.deepEqual(await adapter.forRequest(ctx).establish(42, ['*'], null), {
      userId: 42,
      identifier: '18',
      value: 'token',
    })
  })
  test('refuses a provider token without a releasable bearer value', async ({ assert }) => {
    const deleted: unknown[] = []
    const adapter = createManagedGuard({
      strategy: 'access_tokens',
      name: 'api',
      loadUser: async () => ({
        findOrFail: async () => ({ id: 42 }),
        accessTokens: {
          create: async () => ({ identifier: 18, value: undefined }),
          delete: async (_user: unknown, identifier: unknown) => {
            deleted.push(identifier)
          },
        },
      }),
    })
    await assert.rejects(
      () => adapter.forRequest({} as never).establish(42, ['*'], null),
      /bearer value/
    )
    assert.deepEqual(deleted, [18])
  })
  test('refuses cookie-backed sessions before issuing or trusting a credential', async ({
    assert,
  }) => {
    const adapter = createManagedGuard({
      strategy: 'session',
      name: 'web',
      loadUser: async () => ({ findOrFail: async () => ({ id: 1 }) }),
    })
    const ctx = { session: { config: { store: 'cookie' } } } as never
    assert.throws(() => adapter.forRequest(ctx), /server-side session store/)
    await assert.rejects(() => adapter.current(ctx), /server-side session store/)
  })
  test('refuses an aliased cookie backend and unknown stores without an explicit verifier', async ({
    assert,
  }) => {
    class CookieStore {}
    class CustomStore {}
    let authenticated = false
    const adapter = createManagedGuard({
      strategy: 'session',
      name: 'web',
      loadUser: async () => ({ findOrFail: async () => ({ id: 1 }) }),
    })
    const context = (factory: () => unknown) =>
      ({
        session: {
          config: { store: 'browser', stores: { browser: factory } },
          get: () => undefined,
        },
        auth: {
          use: () => ({
            authenticate: async () => {
              authenticated = true
              return { id: 1 }
            },
          }),
        },
      }) as never
    const cookie = context(() => new CookieStore())
    assert.throws(() => adapter.forRequest(cookie), /server-side session store/)
    await assert.rejects(() => adapter.current(cookie), /server-side session store/)
    assert.isFalse(authenticated)
    const unknown = context(() => new CustomStore())
    assert.throws(() => adapter.forRequest(unknown), /verified server-side session store/)
    const trusted = createManagedGuard({
      strategy: 'session',
      name: 'web',
      loadUser: async () => ({ findOrFail: async () => ({ id: 1 }) }),
      verifySessionStore: (store) => store instanceof CustomStore,
    })
    assert.deepEqual(await trusted.current(unknown), { userId: 1 })
  })
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
        config: serverSessionConfig,
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
            return 1
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
      session: { config: serverSessionConfig },
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
      session: { config: serverSessionConfig },
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
