import { test } from '@japa/runner'
import { E_ACCOUNT_KIT_INVALID_CONFIGURATION } from '../src/errors.ts'
import { defineConfig as defineAdmissionConfig } from '../src/admission/config.ts'
import AdmissionProvider from '../providers/account_admission_provider.ts'
import { AccountAdmission } from '../src/admission/service.ts'
import { AccountKit, defineConfig } from '../src/account_kit.ts'
import { bootTestApp } from './helpers/app.ts'
import { allowDecisions } from './helpers/admission.ts'
import { makeConfig, makeUsersAdapter } from './helpers/fakes.ts'

test.group('admission provider', () => {
  test('binds one admission service after boot, built on the account service', async ({
    assert,
  }) => {
    const app = await bootTestApp({ accountKitProvider: 'source' })
    try {
      new AdmissionProvider(app.app).register()
      app.app.config.set(
        'account_kit',
        defineConfig(makeConfig({ users: makeUsersAdapter(app.db, app.hash) }))
      )
      app.app.config.set(
        'admission',
        defineAdmissionConfig({ approval: { required: true, authorize: allowDecisions } })
      )
      const first = await app.app.container.make(AccountAdmission)
      assert.instanceOf(first, AccountAdmission)
      assert.equal(await app.app.container.make(AccountAdmission), first)
      assert.equal(await app.app.container.make('account_admission'), first)
      assert.equal(first.kit, await app.app.container.make(AccountKit))
    } finally {
      await app.close()
    }
  })

  test('refuses to build without config/admission.ts', async ({ assert }) => {
    const app = await bootTestApp({ accountKitProvider: 'source' })
    try {
      new AdmissionProvider(app.app).register()
      app.app.config.set(
        'account_kit',
        defineConfig(makeConfig({ users: makeUsersAdapter(app.db, app.hash) }))
      )
      let error: unknown
      try {
        await app.app.container.make(AccountAdmission)
      } catch (caught) {
        error = caught
      }
      assert.instanceOf(error, E_ACCOUNT_KIT_INVALID_CONFIGURATION)
      assert.equal(
        (error as InstanceType<typeof E_ACCOUNT_KIT_INVALID_CONFIGURATION>).field,
        'config/admission.ts'
      )
      assert.match((error as Error).message, /config\/admission\.ts/)
    } finally {
      await app.close()
    }
  })
})
