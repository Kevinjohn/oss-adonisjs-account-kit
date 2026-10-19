import { readdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { test } from '@japa/runner'
import { MigrationRunner } from '@adonisjs/lucid/migration'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'
import { createMailNotifications } from '../src/notifications.js'
import { inspectSetup } from '../src/setup/inspect.js'
import { planSetup } from '../src/setup/plan.js'
import { applySetup } from '../src/setup/apply.js'
import { bootTestApp } from './helpers/app.js'
import { pruneExpired } from '../src/maintenance.js'
import { migrationNames } from '../configure.js'
import { socialRegistrationValidator } from '../src/http/validators.js'
import { InvalidInputError } from '../src/errors.js'
import { managedErrorResponse } from '../src/http/responses.js'
import { fixture, registerSetupTeardown } from './helpers/setup.js'

test.group('setup generated sources', (group) => {
  registerSetupTeardown(group)

  for (const [usersTable, timestamp] of [
    ['users', undefined],
    ['users', 1234],
    ['accounts', undefined],
    ['accounts', 1234],
  ] as const) {
    test(`applies every planned migration for ${usersTable} with ${timestamp === undefined ? 'clock' : 'fixed'} timestamp`, async ({
      assert,
    }) => {
      const { root, choices } = await fixture()
      choices.user.table = usersTable
      const plan = await planSetup(choices, await inspectSetup(root), { timestamp })
      const migrations = plan.changes.filter((change) =>
        change.path.startsWith('database/migrations/')
      )
      assert.lengthOf(migrations, migrationNames.length)
      const kit = await bootTestApp()
      try {
        const schema = kit.db.connection().schema
        for (const table of [
          'login_link_tokens',
          'account_sessions',
          'social_handoff_codes',
          'social_sensitive_proofs',
          'social_transactions',
          'social_identities',
          'account_transaction_lock',
          'account_invitations',
          'password_reset_tokens',
          'email_verification_tokens',
          'adonis_schema_versions',
          'adonis_schema',
          'users',
          'accounts',
        ])
          await schema.dropTableIfExists(table)
        await schema.createTable(usersTable, (table) => {
          table.increments('id')
          table.string('email', 254).notNullable().unique()
          table.string('password').nullable()
          table.timestamp('created_at').notNullable()
        })
        await symlink(
          join(process.cwd(), 'node_modules'),
          join(kit.migrationDirectory, 'node_modules')
        )
        for (const migration of migrations)
          await writeFile(
            join(kit.migrationDirectory, migration.path.split('/').at(-1)!),
            migration.content
          )
        const runner = new MigrationRunner(kit.db, kit.app, { direction: 'up' })
        await runner.run()
        if (runner.error) throw runner.error
        assert.isTrue(await kit.db.connection().schema.hasTable('social_identities'))
        assert.isTrue(await kit.db.connection().schema.hasTable('social_transactions'))
        assert.isTrue(
          await kit.db.connection().schema.hasColumn('social_identities', 'confirmed_at')
        )
        assert.isTrue(
          await kit.db.connection().schema.hasColumn(usersTable, 'credentials_changed_at')
        )
        assert.deepEqual(await pruneExpired(kit.db, { dryRun: true }), {
          recovery: 0,
          invitations: 0,
          emailVerifications: 0,
          socialTransactions: 0,
          socialSensitiveProofs: 0,
          socialHandoffCodes: 0,
          loginLinks: 0,
          sessions: 0,
        })
      } finally {
        await kit.close()
      }
    })
  }

  test('assesses six pillars and previews every file without mutation', async ({ assert }) => {
    const { root, choices } = await fixture()
    const state = await inspectSetup(root)
    const plan = await planSetup(choices, state, { timestamp: 1234 })
    assert.isTrue(plan.preview)
    assert.lengthOf(Object.keys(plan.pillars), 6)
    assert.include(plan.pillars.social, 'not applicable')
    assert.deepEqual(plan.endpoints, [
      'auth.csrf',
      'auth.passwordReset.request',
      'auth.passwordReset.inspect',
      'auth.passwordReset.complete',
    ])
    assert.lengthOf(
      plan.changes.filter(({ action }) => action === 'create'),
      18
    )
    assert.isFalse(plan.readiness.productionReady)
    assert.isFalse(plan.readiness.migrationsApplied)
    assert.notInclude(await readdir(join(root, 'config')), 'account_kit_setup.json')
    await assert.rejects(() => applySetup(root, plan), /preview mode/)
  })

  test('generated access and proof middleware run through Adonis lazy registration', async ({
    assert,
  }) => {
    const { root, choices } = await fixture()
    const plan = await planSetup(choices, await inspectSetup(root), {
      apply: true,
      timestamp: 1234,
    })
    const packageRequire = createRequire(import.meta.resolve('@adonisjs/core'))
    const { Container } = await import(pathToFileURL(packageRequire.resolve('@adonisjs/fold')).href)
    const { RouterFactory } = await import(
      pathToFileURL(packageRequire.resolve('@adonisjs/http-server/factories')).href
    )
    const router = new RouterFactory().create()
    const resolver = new Container().createResolver()
    for (const path of [
      'app/middleware/account_kit_access_middleware.ts',
      'app/middleware/account_kit_proof_headers_middleware.ts',
    ]) {
      const generated = plan.changes.find((change) => change.path === path)!.content
      const executable = generated.replace(/^import .*\n/gm, '')
      const stubs = `const app = { container: { make: async () => ({}) } }; class AccountKit {}; const accountKitGuard = {}; const managedAccountMiddleware = () => async (ctx, next) => { ctx.gated = true; return next() }; const managedProofHeadersMiddleware = () => async (ctx, next) => { ctx.gated = true; return next() };\n`
      const compiled = ts.transpileModule(stubs + executable, {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
      }).outputText
      const named = router.named({
        accountKit: () => import(`data:text/javascript,${encodeURIComponent(compiled)}`),
      })
      const ctx = { gated: false }
      const result = await named.accountKit().handle(resolver, ctx, async () => 'passed')
      assert.equal(result, 'passed', path)
      assert.isTrue(ctx.gated, path)
    }
  })

  test('generated Mail callbacks resolve the live service after configuration evaluation', async ({
    assert,
  }) => {
    const { root, choices } = await fixture()
    choices.mail.integration = 'adonisjs-mail'
    choices.mail.senderEnv = 'ACCOUNT_MAIL_FROM'
    choices.mail.transportEnv = 'MAIL_MAILER'
    choices.policy.registrationFields = []
    choices.mail.destinations = { passwordReset: 'account/recovery' }
    const plan = await planSetup(choices, await inspectSetup(root), {
      apply: true,
      timestamp: 1234,
    })
    const generated = plan.changes.find(({ path }) => path === 'config/account_kit.ts')!.content
    const mailUrl = `data:text/javascript,${encodeURIComponent('let mail; export { mail as default }; export const bindMail = value => { mail = value }')}`
    const service = await import(mailUrl)
    const executable = generated
      .replace(/^import .*\n/gm, '')
      .replace('export default defineConfig(', 'return defineConfig(')
      .replaceAll('@adonisjs/mail/services/main', mailUrl)
    const compiled = ts.transpileModule(executable, {
      compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 },
    }).outputText
    const previous = {
      ACCOUNT_MAIL_FROM: process.env.ACCOUNT_MAIL_FROM,
      APP_URL: process.env.APP_URL,
      FRONTEND_URL: process.env.FRONTEND_URL,
    }
    process.env.ACCOUNT_MAIL_FROM = 'accounts@example.test'
    process.env.APP_URL = 'http://localhost:3333'
    process.env.FRONTEND_URL = 'http://localhost:3000'
    try {
      const configured = new Function(
        'env',
        'app',
        'createLucidAdapter',
        'createActionUrls',
        'createMailNotifications',
        'defineConfig',
        'accountKitPolicy',
        'mail',
        compiled
      )(
        { get: () => ({ release: () => 'test-secret' }) },
        { inProduction: false, inTest: true },
        () => ({}),
        () => ({}),
        createMailNotifications,
        (value: unknown) => value,
        { canAccess: async () => true },
        undefined
      ) as { notify: { passwordChanged: (user: { email: string }) => Promise<void> } }
      const sent: string[] = []
      const manager = {
        async sendLater(this: { delivered: boolean }, render: (message: any) => void) {
          this.delivered = true
          const message = {
            to: (address: string) => {
              sent.push(address)
              return message
            },
            from: () => message,
            subject: () => message,
            html: () => message,
            text: () => message,
          }
          render(message)
        },
        delivered: false,
      }
      service.bindMail(manager)
      await configured.notify.passwordChanged({ email: 'recipient@example.test' })
      assert.deepEqual(sent, ['recipient@example.test'])
      assert.isTrue(manager.delivered)
    } finally {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    }
  })

  test('string identifiers render matching foreign keys and token guard only', async ({
    assert,
  }) => {
    const { root, choices } = await fixture()
    choices.user.idType = 'string'
    choices.authentication = {
      strategy: 'access_tokens',
      guard: 'api',
      token: { revocation: true, lifetime: '7d', abilities: ['*'] },
      applicationRouteRevocation: true,
    }
    const plan = await planSetup(choices, await inspectSetup(root), { timestamp: 1234 })
    const migration = plan.changes.find(({ path }) =>
      path.endsWith('create_password_reset_tokens.ts')
    )!
    const guard = plan.changes.find(({ path }) => path === 'app/services/account_kit_guard.ts')!
    assert.include(migration.content, "table.string('tokenable_id', 254)")
    assert.include(guard.content, '"access_tokens"')
    assert.notInclude(plan.endpoints, 'auth.csrf')
    assert.notInclude(
      plan.changes.find(({ path }) => path === 'adonisrc.ts')!.content,
      '@adonisjs/shield'
    )
  })

  test('generated managed and application-owned gates follow verification policy', async ({
    assert,
  }) => {
    const { root, choices } = await fixture()
    choices.policy.verificationRequired = false
    let plan = await planSetup(choices, await inspectSetup(root), { apply: true, timestamp: 1234 })
    assert.include(
      plan.changes.find(({ path }) => path === 'start/account_kit_routes.ts')!.content,
      'verificationRequired: false'
    )
    assert.include(
      plan.changes.find(({ path }) => path === 'app/middleware/account_kit_access_middleware.ts')!
        .content,
      'active: false'
    )
    await applySetup(root, plan)
    choices.policy.verificationRequired = true
    choices.features.push('emailVerification')
    plan = await planSetup(choices, await inspectSetup(root), { apply: true, timestamp: 1234 })
    assert.equal(
      plan.changes.find(({ path }) => path === 'app/middleware/account_kit_access_middleware.ts')!
        .action,
      'update'
    )
    assert.include(
      plan.changes.find(({ path }) => path === 'start/account_kit_routes.ts')!.content,
      'verificationRequired: true'
    )
  })

  test('generated social registration mapper rejects malformed and blank required names after Vine', async ({
    assert,
  }) => {
    const { root, choices } = await fixture()
    choices.policy.registrationFields = [
      { name: 'fullName', type: 'string', required: true, maxLength: 100 },
    ]
    const plan = await planSetup(choices, await inspectSetup(root), { timestamp: 1234 })
    const config = plan.changes.find(({ path }) => path === 'config/account_kit.ts')!.content
    const mapper = config.slice(
      config.indexOf('const registrationFields:'),
      config.indexOf('const users =')
    )
    const executable = ts.transpileModule(`${mapper}\nreturn mapRegistrationFields`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText
    const map = new Function('InvalidInputError', executable)(InvalidInputError) as (
      input: unknown
    ) => Record<string, unknown>
    const validate = async (registrationData: unknown) => {
      const input = await socialRegistrationValidator.validate({
        continuation: 'pending-registration',
        registrationData,
      })
      return map(input.registrationData)
    }

    for (const [registrationData, field] of [
      [null, 'registrationData'],
      [[], 'registrationData'],
      [{ role: 'admin', fullName: 'Ada' }, 'registrationData.role'],
      [{ fullName: 7 }, 'registrationData.fullName'],
      [{ fullName: '   ' }, 'registrationData.fullName'],
      [{ fullName: 'x'.repeat(101) }, 'registrationData.fullName'],
    ] as const) {
      let caught: unknown
      try {
        await validate(registrationData)
      } catch (error) {
        caught = error
      }
      assert.instanceOf(caught, InvalidInputError)
      assert.include((caught as InvalidInputError).message, field)
      assert.deepEqual(managedErrorResponse(caught), {
        status: 422,
        contentType: 'application/json',
        headers: { Vary: 'Accept' },
        body: {
          errors: [{ code: 'E_ACCOUNT_KIT_INVALID_INPUT', message: 'Account request rejected.' }],
        },
      })
    }
    assert.deepEqual(await validate({ fullName: '  Ada  ' }), { fullName: 'Ada' })
  })
})
