import { Encryption } from '@adonisjs/core/encryption'
import { test } from '@japa/runner'
import { AccountKit, defineConfig } from '../src/account_kit.js'
import { CapabilityDisabledError } from '../src/errors.js'
import { useTestApp } from './helpers/app.js'
import { makeConfig, makeUsersAdapter } from './helpers/fakes.js'

test.group('AccountKit constructor compatibility', (group) => {
  const kit = useTestApp(group)

  test('accepts legacy encryption input in a typed object literal', async ({ assert }) => {
    const account = new AccountKit({
      config: defineConfig(makeConfig({ users: makeUsersAdapter(kit.db, kit.hash), enabled: [] })),
      db: kit.db,
      limiter: kit.limiter,
      encryption: await kit.app.container.make(Encryption),
    })

    await assert.rejects(
      () => account.passwordReset.request({ email: 'member@example.com', clientKey: 'client' }),
      CapabilityDisabledError
    )
  })
})
