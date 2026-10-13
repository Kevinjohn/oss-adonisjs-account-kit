import { test } from '@japa/runner'
import { AccountKit, defineConfig } from '../src/account_kit.js'
import { bootTestApp } from './helpers/app.js'
import { makeConfig, makeUsersAdapter } from './helpers/fakes.js'
import { resetSchema } from './helpers/schema.js'

test.group('account kit provider', () => {
  test('resolves one class-bound service with all namespaces', async ({ assert }) => {
    const kit = await bootTestApp({ accountKitProvider: 'source' })
    try {
      await resetSchema(kit.db)
      await kit.limiter.clear()
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
    } finally {
      await kit.close()
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
      const kit = await bootTestApp({ accountKitProvider: 'build' })
      try {
        await resetSchema(kit.db)
        await kit.limiter.clear()
        kit.app.config.set(
          'account_kit',
          root.defineConfig(makeConfig({ users: makeUsersAdapter(kit.db, kit.hash) }))
        )
        const first = await kit.app.container.make(root.AccountKit)
        const second = await kit.app.container.make(root.AccountKit)
        assert.equal(first, second)
        assert.instanceOf(first, root.AccountKit)
      } finally {
        await kit.close()
      }
    })
})
