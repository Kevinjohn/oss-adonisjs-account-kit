import { test } from '@japa/runner'
import { configProvider } from '@adonisjs/core'
import { defineConfig, SessionCollection, stores } from '@adonisjs/session'
import type { ResolvedSessionConfig } from '@adonisjs/session/types'
import { createManagedGuard } from '../src/http/guard.js'
import { protectManagedSessionConfig } from '../src/http/session_store_protection.js'
import { protectedContext, ServerStore } from './helpers/protected_context.js'

test.group('managed existing-guard adapters', () => {
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
})
