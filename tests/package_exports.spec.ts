import { Kernel } from '@adonisjs/core/ace'
import { test } from '@japa/runner'
import { bootTestApp } from './helpers/app.js'
import { makeConfig, makeUsersAdapter } from './helpers/fakes.js'
import { resetSchema } from './helpers/schema.js'

if (process.env.TEST_BUILT_EXPORTS === '1')
  test('loads every built public export and resolves the built class through the built provider', async ({
    assert,
  }) => {
    const root = await import('adonisjs-account-kit')
    const types = await import('adonisjs-account-kit/types')
    const errors = await import('adonisjs-account-kit/errors')
    const provider = await import('adonisjs-account-kit/account_kit_provider')
    const legacyProvider = await import('adonisjs-account-kit/providers/account_kit_provider')
    const adapter = await import('adonisjs-account-kit/adapters/lucid')
    const sql = await import('adonisjs-account-kit/adapters/sql')
    const drizzle = await import('adonisjs-account-kit/adapters/drizzle')
    const prisma = await import('adonisjs-account-kit/adapters/prisma')
    const contract = await import('adonisjs-account-kit/testing/adapter_contract')
    const commands = await import('adonisjs-account-kit/commands')
    const http = await import('adonisjs-account-kit/http')
    const ally = await import('adonisjs-account-kit/ally')
    const capture = await import('adonisjs-account-kit/testing/notifications')
    assert.isFunction(root.AccountKit)
    assert.isFunction(root.defineConfig)
    assert.isFunction(root.configure)
    assert.isFunction(root.createAllySocialProvider)
    assert.equal(ally.createAllySocialProvider, root.createAllySocialProvider)
    assert.lengthOf(Object.keys(types), 0)
    assert.isFunction(errors.ThrottledError)
    assert.equal(root.errors.ThrottledError, errors.ThrottledError)
    assert.equal(root.ThrottledError, errors.ThrottledError)
    assert.isFunction(provider.default)
    assert.equal(legacyProvider.default, provider.default)
    assert.isFunction(adapter.createLucidAdapter)
    assert.isFunction(sql.createSqlUsersAdapter)
    assert.isFunction(drizzle.createDrizzleAdapter)
    assert.isFunction(prisma.createPrismaAdapter)
    assert.isFunction(contract.assertUsersAdapterContract)
    assert.isFunction(capture.captureNotifications)
    assert.isFunction(root.createLogNotifications)
    assert.isFunction(commands.getMetaData)
    assert.isFunction(commands.getCommand)
    assert.isFunction(http.registerManagedRoutes)
    assert.isFunction(http.createManagedGuard)
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
      const service = await import('adonisjs-account-kit/services/main')
      assert.equal(service.default, first)

      const metadata = await commands.getMetaData()
      const pruneMetadata = metadata.find((item) => item.commandName === 'account-kit:prune')
      assert.isDefined(pruneMetadata)
      const pruneCommand = await commands.getCommand(pruneMetadata!)
      assert.isNotNull(pruneCommand)
      const ace = new Kernel(built.app)
      ace.addLoader(commands as never)
      await ace.handle(['account-kit:prune', '--dry-run'])
    } finally {
      await built.close()
    }
  })
