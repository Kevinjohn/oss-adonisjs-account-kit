import { test } from '@japa/runner'
import { configProvider } from '@adonisjs/core/config'
import { defineConfig, SessionCollection, stores } from '@adonisjs/session'
import type { ResolvedSessionConfig } from '@adonisjs/session/types'
import { InvalidSessionError } from '../src/errors.js'
import { createManagedGuard, managedAccountMiddleware } from '../src/http/guard.js'
import { protectManagedSessionConfig } from '../src/http/session_store.js'

class ServerStore {}

async function protectedContext(
  selected: () => unknown = () => new ServerStore(),
  store = 'browser',
  verifyStore: (value: unknown) => boolean = (value) => value instanceof ServerStore
) {
  const config = await configProvider.resolve<{
    store: string
    stores: Record<string, (context: never, config: never) => unknown>
  }>(
    {} as never,
    protectManagedSessionConfig(
      configProvider.create(async () => ({ store, stores: { [store]: selected } })),
      {
        verifyStore,
      }
    )
  )
  if (!config) throw new Error('Test session config did not resolve')
  const context = {} as never
  config.stores[store](context, config as never)
  return { context, config }
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
    const { context, config } = await protectedContext()
    const ctx = Object.assign(context, {
      auth: { use: () => ({ authenticate: async () => ({}) }) },
      session: { config, get: () => undefined },
    }) as never
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
    const { context, config } = await protectedContext()
    const ctx = Object.assign(context, {
      auth: { use: () => ({ authenticate: async () => user }) },
      session: { config, get: () => '' },
    }) as never
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
  test('refuses sessions without the protected configuration before issuing or trusting a credential', async ({
    assert,
  }) => {
    const adapter = createManagedGuard({
      strategy: 'session',
      name: 'web',
      loadUser: async () => ({ findOrFail: async () => ({ id: 1 }) }),
    })
    const ctx = { session: { config: { store: 'cookie' } } } as never
    assert.throws(() => adapter.forRequest(ctx), /protectManagedSessionConfig/)
    await assert.rejects(() => adapter.current(ctx), /protectManagedSessionConfig/)
  })
  test('rejects cookie ancestry on the actual selected instance before custom attestation', async ({
    assert,
  }) => {
    const nativeCookieFactory = await configProvider.resolve<
      (context: never, config: never) => object
    >({} as never, stores.cookie())
    if (!nativeCookieFactory) throw new Error('Native cookie factory did not resolve')
    const Cookie = nativeCookieFactory({} as never, { cookie: {} } as never).constructor as new (
      config: unknown,
      context: unknown
    ) => object
    class DatabaseStore extends Cookie {
      constructor() {
        super({}, {})
      }
    }
    let attestationCalls = 0
    await assert.rejects(
      () =>
        protectedContext(
          () => new DatabaseStore(),
          'browser',
          () => {
            attestationCalls++
            return true
          }
        ),
      /revocable server-side store/
    )
    assert.equal(attestationCalls, 0)
    await assert.rejects(
      () =>
        protectedContext(
          () => nativeCookieFactory({} as never, { cookie: {} } as never),
          'database',
          () => true
        ),
      /revocable server-side store/
    )
    await assert.rejects(
      () =>
        protectedContext(
          () => ({}),
          'database',
          () => false
        ),
      /revocable server-side store/
    )
    await assert.rejects(
      () =>
        protectedContext(() => new ServerStore(), 'database', (() =>
          Promise.resolve(true)) as never),
      /revocable server-side store/
    )
  })
  test('verifies each actual selected instance and accepts a server backend under cookie key', async ({
    assert,
  }) => {
    const nativeCookieFactory = await configProvider.resolve<
      (context: never, config: never) => object
    >({} as never, stores.cookie())
    if (!nativeCookieFactory) throw new Error('Native cookie factory did not resolve')
    let selectedCalls = 0
    const selected = () => {
      selectedCalls++
      return selectedCalls === 1
        ? new ServerStore()
        : nativeCookieFactory({} as never, { cookie: {} } as never)
    }
    const config = await configProvider.resolve<{
      store: string
      stores: Record<string, (context: never, config: never) => unknown>
    }>(
      {} as never,
      protectManagedSessionConfig(
        configProvider.create(async () => ({ store: 'cookie', stores: { cookie: selected } })),
        {
          verifyStore: (value) => value instanceof ServerStore,
        }
      )
    )
    if (!config) throw new Error('Test session config did not resolve')
    const first = { session: { config } } as never
    config.stores.cookie(first, config as never)
    const guard = createManagedGuard({
      strategy: 'session',
      name: 'web',
      loadUser: async () => ({ findOrFail: async () => ({ id: 1 }) }),
    })
    assert.doesNotThrow(() => guard.forRequest(first))
    assert.equal(selectedCalls, 1)
    const second = { session: { config } } as never
    assert.throws(
      () => config.stores.cookie(second, config as never),
      /revocable server-side store/
    )
    assert.throws(() => guard.forRequest(second), /protectManagedSessionConfig/)
    assert.equal(selectedCalls, 2)
    const mismatched = { session: { config: { ...config } } } as never
    assert.throws(() => guard.forRequest(mismatched), /protectManagedSessionConfig/)
    const original = config.stores.cookie
    config.stores.cookie = () => new ServerStore()
    assert.throws(() => guard.forRequest(first), /protectManagedSessionConfig/)
    config.stores.cookie = original
  })
  test('preserves native SessionCollection operations while validating its null-context store', async ({
    assert,
  }) => {
    let checked = 0
    const config = await configProvider.resolve<ResolvedSessionConfig>(
      {} as never,
      protectManagedSessionConfig(
        defineConfig({
          enabled: true,
          cookieName: 'session',
          age: '2h',
          store: 'memory',
          stores: {},
        }),
        {
          verifyStore: (actual) => {
            checked++
            return !!actual && typeof actual === 'object' && 'destroy' in actual
          },
        }
      )
    )
    if (!config) throw new Error('Native session config did not resolve')
    const id = `managed-collection-${Date.now()}`
    const store = config.stores[config.store](null as never, config)
    await store.write(id, { account: 42 })
    const collection = new SessionCollection(config)
    assert.deepEqual(await collection.get(id), { account: 42 })
    assert.isTrue(collection.supportsTagging())
    await collection.tag(id, '42')
    assert.deepEqual(await collection.tagged('42'), [{ id, data: { account: 42 } }])
    await collection.destroy(id)
    assert.isNull(await collection.get(id))
    assert.isAtLeast(checked, 2)

    const cookieConfig = await configProvider.resolve<ResolvedSessionConfig>(
      {} as never,
      protectManagedSessionConfig(
        defineConfig({
          enabled: true,
          cookieName: 'session',
          age: '2h',
          store: 'browser',
          stores: { browser: stores.cookie() },
        }),
        { verifyStore: () => true }
      )
    )
    if (!cookieConfig) throw new Error('Native cookie config did not resolve')
    assert.throws(() => new SessionCollection(cookieConfig), /revocable server-side store/)
  })
  test('session login regenerates, captures revision, and current reads only authenticated state', async ({
    assert,
  }) => {
    const actions: string[] = []
    const values = new Map<string, unknown>()
    const user = { id: 42 }
    const { context, config } = await protectedContext()
    const ctx = Object.assign(context, {
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
        config,
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
    }) as never
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
    const { context, config } = await protectedContext()
    const ctx = Object.assign(context, {
      session: { config },
      auth: {
        use: () => ({
          authenticate: async () => {
            throw unauthorised
          },
        }),
      },
    }) as never
    await assert.rejects(() => adapter.current(ctx), InvalidSessionError)
    const databaseFailure = new Error('database offline')
    const { context: outageContext, config: outageConfig } = await protectedContext()
    const outage = Object.assign(outageContext, {
      session: { config: outageConfig },
      auth: {
        use: () => ({
          authenticate: async () => {
            throw databaseFailure
          },
        }),
      },
    }) as never
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
