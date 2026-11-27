import { test } from '@japa/runner'
import { AccountKit, defineConfig } from '../src/account_kit.ts'
import { ManagedRoutes } from '../src/http/route_registration.ts'
import { bootTestApp, useTestApp } from './helpers/app.ts'
import { makeConfig, makeUsersAdapter } from './helpers/fakes.ts'
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
    assert.property(first.passwordReset, 'request')
    assert.property(first.emailVerification, 'send')
    assert.property(first.invitations, 'accept')
    assert.property(first.emailPasswordManagement, 'completeEmailChange')
    assert.notProperty(first, 'recovery')
    assert.notProperty(first, 'verification')
    assert.notProperty(first, 'credentials')
  })

  test('resolves the account_kit alias to the class-bound singleton', async ({ assert }) => {
    const aliased = await kit.app.container.make('account_kit.manager')
    assert.equal(aliased, await kit.app.container.make(AccountKit))
  })

  test('binds one managed routes service that records each router', async ({ assert }) => {
    const managedRoutes = await kit.app.container.make('account_kit.managed_routes')
    assert.instanceOf(managedRoutes, ManagedRoutes)
    assert.equal(await kit.app.container.make('account_kit.managed_routes'), managedRoutes)
  })

  // A fresh app: the shared one has already cached the singleton.
  test('exports the container singleton from the service entry point', async ({ assert }) => {
    const service = await import('../services/main.js')
    const resolved = await kit.app.container.make(AccountKit)
    assert.equal(service.default, resolved)
  })

  test('refuses to build the service when the config file is missing', async ({ assert }) => {
    const fresh = await bootTestApp({ accountKitProvider: 'source' })
    try {
      fresh.app.config.set('account_kit', undefined)
      await assert.rejects(() => fresh.app.container.make(AccountKit), /config\/account_kit\.ts/)
    } finally {
      await fresh.close()
    }
  })
})
