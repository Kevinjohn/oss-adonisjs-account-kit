import { readdir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { test } from '@japa/runner'
import { MigrationRunner } from '@adonisjs/lucid/migration'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'
import { createMailNotifications } from '../src/notifications.js'
import { inspectSetup } from '../src/setup/inspect.js'
import { planSetup } from '../src/setup/plan.js'
import { applySetup } from '../src/setup/apply.js'
import { bootTestApp, useTestApp } from './helpers/app.js'
import { pruneExpired } from '../src/maintenance.js'
import { migrationNames } from '../configure.js'
import { socialRegistrationValidator } from '../src/http/validators.js'
import { InvalidInputError } from '../src/errors.js'
import { managedErrorResponse } from '../src/http/responses.js'
import { fixture, registerSetupTeardown } from './helpers/setup_project_fixture.js'
import { defineConfig } from '../src/account_kit.js'
import {
  insertUser,
  makeConfig,
  makeService,
  makeUsersAdapter,
  tokenFrom,
} from './helpers/fakes.js'
import { interactive } from './helpers/interactive_choices.js'
import { parseSetupChoices } from '../src/setup/parse.js'

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
          'account_email_changes',
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
      20
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
    assert.include(migration.content, "table.string('user_id', 254)")
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

  test('magic-link sign-in asks for its destination and generates its config and routes', async ({
    assert,
  }) => {
    const answers: Record<string, string> = {
      'Enabled services': 'authentication,magicLinkLogin',
      'Managed endpoint groups': 'authentication,magicLinkLogin',
      'Existing guard strategy': 'access_tokens',
      'Existing guard name': 'api',
      'Token revocation': 'yes',
      'Application-owned protected': 'yes',
      'Delivery integration': 'custom',
      'magicLink relative': 'login/link',
    }
    const asked = await interactive(answers)
    assert.equal(asked.mail.destinations.magicLink, 'login/link')
    assert.deepEqual(parseSetupChoices(asked), asked)

    const { root, choices } = await fixture()
    choices.features.push('magicLinkLogin')
    choices.managed.push('magicLinkLogin')
    choices.mail.destinations.magicLink = 'account/magic-link'
    const plan = await planSetup(choices, await inspectSetup(root), {
      apply: true,
      timestamp: 1234,
    })
    const config = plan.changes.find(({ path }) => path === 'config/account_kit.ts')!.content!
    assert.include(config, '"magicLinkLogin"')
    assert.include(config, '"magicLink":"account/magic-link"')
    const routes = plan.changes.find(({ path }) => path === 'start/account_kit_routes.ts')!.content!
    assert.include(routes, '"magicLinkLogin"')

    delete choices.mail.destinations.magicLink
    choices.authentication = null
    const blocked = await planSetup(choices, await inspectSetup(root), {
      apply: true,
      timestamp: 1234,
    })
    assert.includeMembers(
      blocked.diagnostics.map(({ field, message }) => `${field}: ${message}`),
      [
        'authentication: Magic-link sign-in requires a selected existing guard',
        'mail.destinations.magicLink: Enabled email flow needs a relative frontend destination',
      ]
    )
  })

  test('session management generates its config and routes and requires a guard', async ({
    assert,
  }) => {
    const { root, choices } = await fixture()
    choices.features.push('sessionManagement')
    choices.managed.push('sessionManagement')
    const plan = await planSetup(choices, await inspectSetup(root), {
      apply: true,
      timestamp: 1234,
    })
    const config = plan.changes.find(({ path }) => path === 'config/account_kit.ts')!.content!
    assert.include(config, '"sessionManagement"')
    const routes = plan.changes.find(({ path }) => path === 'start/account_kit_routes.ts')!.content!
    assert.include(routes, '"sessionManagement"')

    choices.authentication = null
    const blocked = await planSetup(choices, await inspectSetup(root), {
      apply: true,
      timestamp: 1234,
    })
    assert.include(
      blocked.diagnostics.map(({ field, message }) => `${field}: ${message}`),
      'authentication: Session management requires a selected existing guard'
    )
  })

  test('account export and deletion generate their config and routes; deletion needs email', async ({
    assert,
  }) => {
    const { root, choices } = await fixture()
    choices.features.push('dataExport', 'accountDeletion')
    choices.managed.push('dataExport', 'accountDeletion')
    const plan = await planSetup(choices, await inspectSetup(root), {
      apply: true,
      timestamp: 1234,
    })
    const messages = (diagnostics: typeof plan.diagnostics) =>
      diagnostics.map(({ field, message }) => `${field}: ${message}`)
    const emailNeeded =
      'features: Account deletion sends a confirmation email; also select an email service such as passwordReset'
    assert.notInclude(messages(plan.diagnostics), emailNeeded)
    const config = plan.changes.find(({ path }) => path === 'config/account_kit.ts')!.content!
    assert.include(config, '"dataExport"')
    assert.include(config, '"accountDeletion"')
    const routes = plan.changes.find(({ path }) => path === 'start/account_kit_routes.ts')!.content!
    assert.include(routes, '"accountDeletion"')

    choices.features = ['authentication', 'accountDeletion']
    const blocked = await planSetup(choices, await inspectSetup(root), {
      apply: true,
      timestamp: 1234,
    })
    assert.include(messages(blocked.diagnostics), emailNeeded)
  })
})

async function generatedInvitationAcceptanceHook(kit: ReturnType<typeof useTestApp>) {
  const stubsRoot = fileURLToPath(new URL('../stubs', import.meta.url))
  const stubs = await kit.app.stubs.create()
  const stub = await stubs.build('config/account_kit.stub', { source: stubsRoot })
  const rendered = await stub.prepare({
    config: { destination: join(tmpdir(), 'account_kit_generated_config.ts') },
  })
  const sourceFile = ts.createSourceFile(
    'account_kit_generated_config.ts',
    rendered.contents,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  )
  let initializer: ts.Expression | undefined
  const visit = (node: ts.Node) => {
    if (
      ts.isPropertyAssignment(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'onInvitationAccepted'
    ) {
      initializer = node.initializer
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  if (!initializer) throw new Error('Rendered config is missing onInvitationAccepted')

  const javascript = ts.transpileModule(
    `const hook = ${initializer.getText(sourceFile)}; export default hook`,
    {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }
  ).outputText
  const imported = await import(
    `data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`
  )
  return imported.default as (...args: never[]) => Promise<void>
}

test.group('generated invitation acceptance setup hook', (group) => {
  const kit = useTestApp(group)

  test('requires the acceptance hook to be present and callable when invitations are enabled', ({
    assert,
  }) => {
    const base = makeConfig({ users: makeUsersAdapter(kit.db, kit.hash), enabled: ['invitations'] })
    assert.throws(
      () => defineConfig({ ...base, onInvitationAccepted: undefined }),
      /onInvitationAccepted must be a function/
    )
    assert.throws(
      () => defineConfig({ ...base, onInvitationAccepted: 'not callable' } as never),
      /onInvitationAccepted must be a function/
    )
  })

  test('the rendered placeholder throws inside acceptance and rolls back user and token consumption', async ({
    assert,
  }) => {
    const actor = await insertUser(kit, { email: 'inviter@example.test' })
    const hook = await generatedInvitationAcceptanceHook(kit)
    const { account, recorder } = makeService(kit, {
      minRequestMs: 0,
      onInvitationAccepted: hook as never,
    })
    const invitation = await account.invitations.send({
      actorId: actor.id,
      email: 'invitee@example.test',
      role: 'member',
    })
    const token = tokenFrom(recorder.calls[0].args[1])

    await assert.rejects(
      () => account.invitations.accept({ token, password: 'new-password123' }),
      'account_kit: implement onInvitationAccepted in config/account_kit.ts'
    )
    assert.lengthOf(await kit.db.from('users').where('email', invitation.email), 0)
    assert.isNotNull(await kit.db.from('account_invitations').where('id', invitation.id).first())
    assert.lengthOf(recorder.calls, 1)
  })
})
