import { resolveAccountKitConfig } from '../src/config_resolution.ts'
import { resolveAdmissionConfig } from '../src/admission/config.ts'
import { test } from '@japa/runner'
import { AccountKit, defineConfig } from '../src/account_kit.ts'
import { AdmissionCallbackRegistry } from '../src/admission/callback_registry.ts'
import { defineConfig as defineAdmissionConfig } from '../src/admission/config.ts'
import AdmissionProvider from '../providers/account_admission_provider.ts'
import { AccountAdmission } from '../src/admission/service.ts'
import type { AdmissionConfig } from '../src/admission/types.ts'
import { AccountKitCallbackRegistry } from '../src/account_kit_callback_registry.ts'
import { E_ACCOUNT_KIT_INVALID_CONFIGURATION } from '../src/errors.ts'
import type { AccountKitCallbacks, AccountKitConfig } from '../src/types.ts'
import { bootTestApp, type TestApp } from './helpers/app.ts'
import { allowDecisions } from './helpers/admission.ts'
import { allowAll, makeConfig, makeUsersAdapter } from './helpers/fakes.ts'

/** A full config without the fields the registry can supply. */
function plainConfig(overrides: Partial<AccountKitConfig> = {}): AccountKitConfig {
  const { users, authorize, onInvitationAccepted, ...rest } = makeConfig({ users: undefined })
  void [users, authorize, onInvitationAccepted]
  return { ...rest, ...overrides }
}

function callbacks(app: TestApp): Required<AccountKitCallbacks> {
  return {
    users: makeUsersAdapter(app.db, app.hash),
    authorize: allowAll,
    mapRegistrationFields: async () => ({}),
    onInvitationAccepted: async () => {},
    onCredentialsChangedTransaction: async () => {},
    onAccountDeletingTransaction: async () => {},
  }
}

async function withApp(run: (app: TestApp) => Promise<void>): Promise<void> {
  const app = await bootTestApp({ accountKitProvider: 'source' })
  try {
    new AdmissionProvider(app.app).register()
    await run(app)
  } finally {
    await app.close()
  }
}

async function rejection(
  run: () => Promise<unknown>
): Promise<InstanceType<typeof E_ACCOUNT_KIT_INVALID_CONFIGURATION>> {
  try {
    await run()
  } catch (error) {
    if (error instanceof E_ACCOUNT_KIT_INVALID_CONFIGURATION) return error
    throw error
  }
  throw new Error('Expected an E_ACCOUNT_KIT_INVALID_CONFIGURATION')
}

test.group('callback registry', () => {
  test('binds one registry under its class and alias for each service', async ({ assert }) => {
    await withApp(async ({ app }) => {
      const registry = await app.container.make('account_kit.callbacks')
      assert.instanceOf(registry, AccountKitCallbackRegistry)
      assert.equal(await app.container.make(AccountKitCallbackRegistry), registry)
      const admission = await app.container.make('account_admission.callbacks')
      assert.instanceOf(admission, AdmissionCallbackRegistry)
      assert.equal(await app.container.make(AdmissionCallbackRegistry), admission)
    })
  })

  test('registered callbacks reach the built account service', async ({ assert }) => {
    await withApp(async (app) => {
      const registered = callbacks(app)
      app.app.config.set('account_kit', defineConfig(plainConfig()))
      const registry = await app.app.container.make('account_kit.callbacks')
      registry.register(async () => registered)
      await app.app.container.make(AccountKit)
      const config = (await resolveAccountKitConfig(app.app))!
      assert.equal(config.users, registered.users)
      assert.equal(await config.authorize.invite({} as never, {} as never), true)
      assert.isFunction(config.registration.mapFields)
      assert.equal(config.registration.availability, 'open')
      for (const hook of [
        'onInvitationAccepted',
        'onCredentialsChangedTransaction',
        'onAccountDeletingTransaction',
      ] as const)
        assert.isFunction(config[hook])
    })
  })

  test('registered callbacks reach the built admission service', async ({ assert }) => {
    await withApp(async (app) => {
      const onAdmissionEvent = async () => {}
      app.app.config.set(
        'account_kit',
        defineConfig(makeConfig({ users: makeUsersAdapter(app.db, app.hash) }))
      )
      app.app.config.set('admission', defineAdmissionConfig({ approval: { required: true } }))
      const registry = await app.app.container.make('account_admission.callbacks')
      registry.register(() => ({ approvalAuthorize: allowDecisions, onAdmissionEvent }))
      await app.app.container.make(AccountAdmission)
      const config = resolveAdmissionConfig(
        app.app.config.get('admission'),
        await registry.resolve()
      )
      assert.equal(config.approval?.authorize, allowDecisions)
      assert.equal(config.onAdmissionEvent, onAdmissionEvent)
    })
  })

  test('refuses a second registration', async ({ assert }) => {
    for (const Registry of [AccountKitCallbackRegistry, AdmissionCallbackRegistry]) {
      const registry = new Registry()
      registry.register(() => ({}))
      const error = await rejection(async () => registry.register(() => ({})))
      assert.equal(error.field, 'callbacks')
      assert.equal(error.message, 'account_kit: callbacks are already registered')
    }
  })

  test('refuses a registration after the service was first resolved', async ({ assert }) => {
    await withApp(async (app) => {
      app.app.config.set(
        'account_kit',
        defineConfig(makeConfig({ users: makeUsersAdapter(app.db, app.hash) }))
      )
      app.app.config.set('admission', defineAdmissionConfig({ invitation: { required: true } }))
      await app.app.container.make(AccountAdmission)
      for (const [alias, service] of [
        ['account_kit.callbacks', 'account_kit'],
        ['account_admission.callbacks', 'account_admission'],
      ] as const) {
        const registry = await app.app.container.make(alias)
        const error = await rejection(async () => registry.register(() => ({})))
        assert.equal(error.field, 'callbacks')
        assert.equal(
          error.message,
          `account_kit: callbacks must be registered before ${service} is first resolved`
        )
      }
    })
  })

  test('refuses an account field set in both places, naming it', async ({ assert }) => {
    for (const field of [
      'users',
      'authorize',
      'registration.mapFields',
      'onInvitationAccepted',
      'onCredentialsChangedTransaction',
      'onAccountDeletingTransaction',
    ] as const) {
      await withApp(async (app) => {
        const registered = callbacks(app)
        const config =
          field === 'registration.mapFields'
            ? { registration: { availability: 'open' as const, mapFields: () => ({}) } }
            : { [field]: registered[field] }
        app.app.config.set('account_kit', defineConfig(plainConfig(config)))
        const registry = await app.app.container.make('account_kit.callbacks')
        registry.register(() => registered)
        const error = await rejection(() => app.app.container.make(AccountKit))
        assert.equal(error.field, field)
        assert.equal(
          error.message,
          `account_kit: ${field} is set in both config/account_kit.ts and the registered callbacks`
        )
      })
    }
  })

  test('refuses an admission field set in both places, naming it', async ({ assert }) => {
    for (const [field, registered] of [
      ['approval.authorize', { approvalAuthorize: allowDecisions }],
      ['onAdmissionEvent', { onAdmissionEvent: async () => {} }],
    ] as const) {
      await withApp(async (app) => {
        app.app.config.set(
          'account_kit',
          defineConfig(makeConfig({ users: makeUsersAdapter(app.db, app.hash) }))
        )
        app.app.config.set(
          'admission',
          defineAdmissionConfig({
            approval: { required: true, authorize: allowDecisions },
            onAdmissionEvent: async () => {},
          })
        )
        const registry = await app.app.container.make('account_admission.callbacks')
        registry.register(() => registered)
        const error = await rejection(() => app.app.container.make(AccountAdmission))
        assert.equal(error.field, `admission.${field}`)
        assert.equal(
          error.message,
          `account_kit: admission ${field} is set in both config/admission.ts and the registered callbacks`
        )
      })
    }
  })

  test('a required field missing from both places throws the same error as before', async ({
    assert,
  }) => {
    await withApp(async (app) => {
      app.app.config.set('account_kit', defineConfig(plainConfig({ authorize: allowAll })))
      const error = await rejection(() => app.app.container.make(AccountKit))
      assert.equal(error.field, 'users')
      assert.equal(error.message, 'account_kit: users adapter must be configured')
    })
    await withApp(async (app) => {
      app.app.config.set('account_kit', defineConfig(plainConfig()))
      const registry = await app.app.container.make('account_kit.callbacks')
      registry.register(() => ({ users: makeUsersAdapter(app.db, app.hash) }))
      const error = await rejection(() => app.app.container.make(AccountKit))
      assert.equal(error.field, 'authorize.invite')
      assert.equal(error.message, 'account_kit: authorize.invite must be a function')
    })
    await withApp(async (app) => {
      app.app.config.set(
        'account_kit',
        defineConfig(makeConfig({ users: makeUsersAdapter(app.db, app.hash) }))
      )
      app.app.config.set('admission', defineAdmissionConfig({ approval: { required: true } }))
      const error = await rejection(() => app.app.container.make(AccountAdmission))
      assert.equal(error.field, 'admission.approval.authorize')
      assert.equal(error.message, 'account_kit: admission approval.authorize must be an object')
    })
  })

  test('refuses registered callbacks that are not an object', async ({ assert }) => {
    await withApp(async (app) => {
      app.app.config.set('account_kit', defineConfig(plainConfig()))
      const registry = await app.app.container.make('account_kit.callbacks')
      registry.register(() => 'callbacks' as never)
      const error = await rejection(() => app.app.container.make(AccountKit))
      assert.equal(error.field, 'callbacks')
    })
    await withApp(async (app) => {
      app.app.config.set(
        'account_kit',
        defineConfig(makeConfig({ users: makeUsersAdapter(app.db, app.hash) }))
      )
      app.app.config.set('admission', defineAdmissionConfig({ invitation: { required: true } }))
      const registry = await app.app.container.make('account_admission.callbacks')
      registry.register(() => 'callbacks' as never)
      const error = await rejection(() => app.app.container.make(AccountAdmission))
      assert.equal(error.field, 'callbacks')
    })
  })

  test('a config that passes everything keeps working with nothing registered', async ({
    assert,
  }) => {
    await withApp(async (app) => {
      const config = defineConfig(makeConfig({ users: makeUsersAdapter(app.db, app.hash) }))
      const admission: AdmissionConfig = { approval: { required: true, authorize: allowDecisions } }
      app.app.config.set('account_kit', config)
      app.app.config.set('admission', defineAdmissionConfig(admission))
      const service = await app.app.container.make(AccountAdmission)
      assert.equal(service.kit, await app.app.container.make('account_kit.manager'))
      assert.equal(await resolveAccountKitConfig(app.app), await resolveAccountKitConfig(app.app))
    })
  })
})
