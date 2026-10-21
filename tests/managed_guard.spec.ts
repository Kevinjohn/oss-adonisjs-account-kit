import { test } from '@japa/runner'
import { InvalidSessionError } from '../src/errors.js'
import { createManagedGuard, managedAccountMiddleware } from '../src/http/guard.js'
import { protectedContext } from './helpers/protected_context.js'

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
    await adapter.forRequest(ctx).refresh!('revision-2')
    assert.deepEqual(await adapter.current(ctx), { userId: 42, revision: 'revision-2' })
    await adapter.forRequest(ctx).refresh!(null)
    assert.deepEqual(await adapter.current(ctx), { userId: 42, revision: null })
    assert.deepEqual(actions, ['regenerate', 'login', 'regenerate', 'regenerate'])
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

  test('session login stores the sign-in handle and current returns it', async ({ assert }) => {
    const values = new Map<string, unknown>()
    const user = { id: 42 }
    const { context, config } = await protectedContext()
    const ctx = Object.assign(context, {
      auth: {
        use: () => ({ authenticate: async () => user, login: async () => {} }),
      },
      session: {
        config,
        regenerate: () => {},
        put: (key: string, value: unknown) => void values.set(key, value),
        get: (key: string) => values.get(key),
      },
    }) as never
    const adapter = createManagedGuard({
      strategy: 'session',
      name: 'web',
      loadUser: async () => ({ findOrFail: async () => user }),
    })
    await adapter.forRequest(ctx).establish(42, null)
    assert.deepEqual(await adapter.current(ctx), { userId: 42, revision: null })
    await adapter.forRequest(ctx).establish(42, null, 'handle-1')
    assert.equal(values.get('accountKitSession'), 'handle-1')
    assert.deepEqual(await adapter.current(ctx), {
      userId: 42,
      revision: null,
      sessionHandle: 'handle-1',
    })
    values.set('accountKitSession', 7)
    await assert.rejects(() => adapter.current(ctx), InvalidSessionError)
  })

  test('token login names the token only when a label is given', async ({ assert }) => {
    const created: unknown[] = []
    const user = { id: 'user-1' }
    const adapter = createManagedGuard({
      strategy: 'access_tokens',
      name: 'api',
      loadUser: async () => ({
        findOrFail: async () => user,
        accessTokens: {
          create: async (_user: unknown, _abilities: string[], options?: unknown) => {
            created.push(options)
            return { identifier: 1, value: { release: () => 'token' } }
          },
          delete: async () => {},
        },
      }),
    })
    const request = adapter.forRequest({} as never)
    await request.establish('user-1', ['*'], null)
    await request.establish('user-1', ['*'], null, { name: 'Phone' })
    await request.establish('user-1', ['*'], '1d', { name: 'Phone' })
    await request.establish('user-1', ['*'], '1d', {})
    assert.deepEqual(created, [
      undefined,
      { name: 'Phone' },
      { expiresIn: '1d', name: 'Phone' },
      { expiresIn: '1d' },
    ])
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
