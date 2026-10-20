import { test } from '@japa/runner'
import { defineAdmission } from '../src/admission/config.js'
import AdmissionProvider from '../src/admission/provider.js'
import { AccountAdmission } from '../src/admission/service.js'
import { AccountKit, defineConfig } from '../src/account_kit.js'
import { bootTestApp } from './helpers/app.js'
import { allowDecisions } from './helpers/admission.js'
import { makeConfig, makeUsersAdapter } from './helpers/fakes.js'

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
        defineAdmission({ approval: { required: true, authorize: allowDecisions } })
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
      await assert.rejects(() => app.app.container.make(AccountAdmission), /config\/admission\.ts/)
    } finally {
      await app.close()
    }
  })
})
