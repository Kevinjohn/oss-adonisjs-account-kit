import { test } from '@japa/runner'
import { AccountKit, defineConfig } from '../src/account_kit.js'
import { bootTestApp, useTestApp } from './helpers/app.js'
import { makeConfig, makeUsersAdapter } from './helpers/fakes.js'
import { resetSchema } from './helpers/schema.js'
test.group('account kit provider', (group) => {
  const kit = useTestApp(group, { accountKitProvider: 'source' })

  test('resolves one class-bound service with all namespaces', async ({ assert }) => {
    kit.app.config.set(
      'account_kit',
      defineConfig(makeConfig({ users: makeUsersAdapter(kit.db, kit.hash) }))
    )
    const first = await kit.app.container.make(AccountKit)
    const second = await kit.app.container.make(AccountKit)
    assert.equal(first, second)
    assert.property(first.recovery, 'request')
    assert.property(first.verification, 'send')
    assert.property(first.invitations, 'accept')
    assert.property(first.credentials, 'completeEmailChange')
  })

  // A fresh app: the shared one has already cached the singleton.
  test('refuses to build the service when the config file is missing', async ({ assert }) => {
    const fresh = await bootTestApp({ accountKitProvider: 'source' })
    try {
      fresh.app.config.set('account_kit', undefined)
      await assert.rejects(() => fresh.app.container.make(AccountKit), /config\/account_kit\.ts/)
    } finally {
      await fresh.close()
    }
  })

  if (process.env.TEST_BUILT_EXPORTS === '1')
    test('loads every built public export and resolves the built class through the built provider', async ({
      assert,
    }) => {
      const root = await import('adonisjs-account-kit')
      const types = await import('adonisjs-account-kit/types')
      const errors = await import('adonisjs-account-kit/errors')
      const provider = await import('adonisjs-account-kit/providers/account_kit_provider')
      assert.isFunction(root.AccountKit)
      assert.isFunction(root.defineConfig)
      assert.isFunction(root.configure)
      assert.lengthOf(Object.keys(types), 0)
      assert.isFunction(errors.ThrottledError)
      assert.isFunction(provider.default)
      const built = await bootTestApp({ accountKitProvider: 'build' })
      try {
        await resetSchema(built)
        await built.limiter.clear()
        built.app.config.set(
          'account_kit',
          root.defineConfig(makeConfig({ users: makeUsersAdapter(built.db, built.hash) }))
        )
        const first = await built.app.container.make(root.AccountKit)
        const second = await built.app.container.make(root.AccountKit)
        assert.equal(first, second)
        assert.instanceOf(first, root.AccountKit)
      } finally {
        await built.close()
      }
    })
})
