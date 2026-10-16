import {
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  readlink,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from '@japa/runner'
import { ListLoader } from '@adonisjs/core/ace'
import { IgnitorFactory } from '@adonisjs/core/factories'
import { pathToFileURL } from 'node:url'
import SetupAccountKit from '../commands/setup.js'
import RetirementImpact from '../commands/retirement_impact.js'
import { AccountKit } from '../src/account_kit.js'

const cleanupRoots: string[] = []
import { defaultSetupChoices } from '../src/setup/defaults.js'
import { inspectSetup } from '../src/setup/inspect.js'
import { planSetup } from '../src/setup/plan.js'
import { applySetup } from '../src/setup/apply.js'
import { parseSetupChoices } from '../src/setup/parse.js'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'account-setup-'))
  cleanupRoots.push(root)
  await mkdir(join(root, 'config'), { recursive: true })
  await mkdir(join(root, 'start'), { recursive: true })
  await mkdir(join(root, 'app/models'), { recursive: true })
  await mkdir(join(root, 'app/services'), { recursive: true })
  await writeFile(
    join(root, 'app/models/user.ts'),
    "import { BaseModel, column } from '@adonisjs/lucid/orm'\nexport default class User extends BaseModel { @column({ isPrimary: true }) declare id: number; static accessTokens = tokens; email!: string; password!: string; emailVerifiedAt!: Date }\n"
  )
  await writeFile(
    join(root, 'app/services/account_kit_policy.ts'),
    'export const accountKitPolicy = { canAccess: async () => true }\n'
  )
  await writeFile(
    join(root, 'app/services/account_kit_notifications.ts'),
    'export const accountKitNotifications = {}\n'
  )
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({
      dependencies: {
        'typescript': '^5.9.3',
        '@adonisjs/core': '7',
        '@adonisjs/lucid': '22',
        '@adonisjs/limiter': '3',
        '@adonisjs/auth': '10',
        '@adonisjs/session': '8',
        '@adonisjs/shield': '9',
        '@vinejs/vine': '4',
        'adonisjs-account-kit': '0',
      },
      imports: { '#models/*': './app/models/*.js', '#database/*': './database/*.js' },
    })
  )
  for (const [name, version] of Object.entries({
    'typescript': '5.9.3',
    '@adonisjs/core': '7.0.0',
    '@adonisjs/lucid': '22.4.2',
    '@adonisjs/limiter': '3.0.0',
    '@adonisjs/auth': '10.1.0',
    '@adonisjs/session': '8.1.0',
    '@adonisjs/shield': '9.0.0',
    '@vinejs/vine': '4.4.0',
    'adonisjs-account-kit': '0.0.0',
  })) {
    await mkdir(join(root, 'node_modules', name), { recursive: true })
    await writeFile(
      join(root, 'node_modules', name, 'package.json'),
      JSON.stringify({ name, version })
    )
  }
  await writeFile(
    join(root, 'config/auth.ts'),
    "import { defineConfig } from '@adonisjs/auth'\nimport { sessionGuard, sessionUserProvider } from '@adonisjs/auth/session'\nimport { tokensGuard, tokensUserProvider } from '@adonisjs/auth/access_tokens'\nexport default defineConfig({ guards: { web: sessionGuard({ provider: sessionUserProvider({ model: () => import('#models/user') }) }), api: tokensGuard({ provider: tokensUserProvider({ model: () => import('#models/user') }) })\n} })\n"
  )
  await writeFile(
    join(root, 'config/database.ts'),
    "import { defineConfig } from '@adonisjs/lucid'\nexport default defineConfig({ connection: 'sqlite', connections: { sqlite: { client: 'better-sqlite3' } } })\n"
  )
  await writeFile(
    join(root, 'config/limiter.ts'),
    'import { defineConfig, stores } from \'@adonisjs/limiter\'\nexport default defineConfig({ default: "database", stores: { database: stores.database({ tableName: "rate_limits" }) } })\n'
  )
  await writeFile(join(root, 'config/shield.ts'), 'export default { csrf: { enabled: true } }\n')
  await writeFile(
    join(root, 'config/session.ts'),
    "import { defineConfig, stores } from '@adonisjs/session'\nconst sessionConfig = defineConfig({ store: 'database', stores: { database: stores.database() } })\nexport default sessionConfig\n"
  )
  await writeFile(join(root, 'adonisrc.ts'), 'export default { providers: [] }\n')
  await writeFile(join(root, 'start/routes.ts'), '// application routes\n')
  await writeFile(
    join(root, 'start/kernel.ts'),
    "import router from '@adonisjs/core/services/router'\nimport server from '@adonisjs/core/services/server'\nserver.use([\n  () => import('@adonisjs/cors/cors_middleware'),\n])\nrouter.use([\n  () => import('@adonisjs/core/bodyparser_middleware'),\n])\n"
  )
  const choices = defaultSetupChoices()
  choices.features = ['passwordReset']
  choices.managed = ['passwordReset']
  choices.authentication!.applicationRouteRevocation = true
  choices.policy.accessRestrictionHook = true
  choices.policy.registration = 'closed'
  choices.policy.verificationRequired = false
  choices.mail.integration = 'custom'
  choices.mail.senderEnv = null
  choices.mail.transportEnv = null
  choices.mail.destinations = { passwordReset: 'account/recovery' }
  choices.social = { status: 'approved-pending', providers: ['google', 'github'] }
  return { root, choices }
}

function retirementIgnitor(
  root: string,
  impact: () => Promise<{ inspectedAccounts: number; affectedAccounts: number; checkedAt: string }>
) {
  const provider = async () => ({
    default: class {
      constructor(
        private app: {
          container: { bindValue: (key: typeof AccountKit, value: AccountKit) => void }
        }
      ) {}
      register() {
        this.app.container.bindValue(AccountKit, {
          authentication: { retirementImpact: impact },
        } as unknown as AccountKit)
      }
    },
  })
  return new IgnitorFactory()
    .withCoreProviders()
    .withCoreConfig()
    .merge({
      rcFileContents: {
        providers: [provider],
        commands: [async () => new ListLoader([SetupAccountKit, RetirementImpact])],
      },
    })
    .create(pathToFileURL(`${root}/`))
}

test.group('onboarding plan and apply', (group) => {
  group.teardown(async () => {
    for (const root of cleanupRoots) await rm(root, { recursive: true, force: true })
  })

  test('standard defaults require explicit invitation and social opt-in', ({ assert }) => {
    const choices = defaultSetupChoices()
    assert.notInclude(choices.features, 'invitations')
    assert.notInclude(choices.managed, 'invitations')
    assert.equal(choices.social.status, 'not-applicable')
    assert.equal(choices.mail.integration, 'adonisjs-mail')
  })

  test('interactive token answers produce complete parseable choices including invitation destination', async ({
    assert,
  }) => {
    const answers: Record<string, string> = {
      'Enabled services': 'authentication,invitations',
      'Managed endpoint groups': 'authentication,invitations',
      'Managed endpoint exclusions': 'auth.invitation.inspect',
      'Existing guard strategy': 'access_tokens',
      'Existing guard name': 'api',
      'Token revocation': 'yes',
      'Application-owned protected': 'yes',
      'Delivery integration': 'custom',
      'invitation relative': 'invites/accept',
      'Additional registration fields': '[{"name":"fullName","type":"string","required":true}]',
      'Application invitation permission': 'yes',
    }
    const choices = await SetupAccountKit.prototype.interactiveChoices.call(
      { logger: { info() {} } } as unknown as SetupAccountKit,
      async (question) =>
        Object.entries(answers).find(([prefix]) => question.startsWith(prefix))?.[1] ?? ''
    )
    assert.equal(choices.authentication?.strategy, 'access_tokens')
    assert.deepEqual(choices.managedExcept, ['auth.invitation.inspect'])
    assert.isFalse(Object.hasOwn(choices.authentication!, 'session'))
    assert.equal(choices.mail.destinations.invitation, 'invites/accept')
    assert.lengthOf(choices.policy.registrationFields, 1)
    assert.deepEqual(parseSetupChoices(choices), choices)
  })

  test('requires manual resolution for a model with unproven inherited mapping', async ({
    assert,
  }) => {
    const { root, choices } = await fixture()
    await writeFile(
      join(root, 'app/models/user.ts'),
      'export default class User extends UserSchema {}\n'
    )
    const plan = await planSetup(choices, await inspectSetup(root), { timestamp: 1234 })
    assert.isTrue(
      plan.diagnostics.some(
        ({ field, severity }) => field === 'user.connection' && severity === 'error'
      )
    )
  })

  test('application-admitted registration cannot expose the managed public signup route', async ({
    assert,
  }) => {
    const { root, choices } = await fixture()
    choices.features.push('registration')
    choices.managed.push('registration')
    choices.policy.registration = 'application'
    const plan = await planSetup(choices, await inspectSetup(root), {
      apply: true,
      timestamp: 1234,
    })
    assert.include(
      plan.diagnostics.map(({ field }) => field),
      'policy.registration'
    )
    await assert.rejects(() => applySetup(root, plan), /blocking diagnostics/)
  })

  test('unresolved database selection blocks apply before any write', async ({ assert }) => {
    const { root, choices } = await fixture()
    await writeFile(
      join(root, 'config/database.ts'),
      "import { defineConfig } from '@adonisjs/lucid'\nimport env from '#start/env'\nconst other = await import('#start/env')\nother.default.get = () => 'mysql'\nexport default defineConfig({ connection: env.get('DB_CONNECTION', 'sqlite'), connections: { sqlite: { client: 'better-sqlite3' }, mysql: { client: 'mysql2' } } })"
    )
    const state = await inspectSetup(root)
    assert.equal(state.database, 'unknown')
    const before = await readdir(root)
    const plan = await planSetup(choices, state, { apply: true, timestamp: 1234 })
    assert.isTrue(
      plan.diagnostics.some(
        ({ field, severity }) => field === 'database.client' && severity === 'error'
      )
    )
    await assert.rejects(() => applySetup(root, plan), /blocking diagnostics/)
    assert.deepEqual(await readdir(root), before)
  })

  test('assesses six pillars and previews every file without mutation', async ({ assert }) => {
    const { root, choices } = await fixture()
    const state = await inspectSetup(root)
    const plan = await planSetup(choices, state, { timestamp: 1234 })
    assert.isTrue(plan.preview)
    assert.lengthOf(Object.keys(plan.pillars), 6)
    assert.include(plan.pillars.social, 'pending')
    assert.deepEqual(plan.endpoints, [
      'auth.csrf',
      'auth.passwordReset.request',
      'auth.passwordReset.inspect',
      'auth.passwordReset.complete',
    ])
    assert.lengthOf(
      plan.changes.filter(({ action }) => action === 'create'),
      15
    )
    assert.isFalse(plan.readiness.productionReady)
    assert.isFalse(plan.readiness.migrationsApplied)
    assert.notInclude(await readdir(join(root, 'config')), 'account_kit_setup.json')
    await assert.rejects(() => applySetup(root, plan), /preview mode/)
  })

  test('refuses every differing file before writing any planned file', async ({ assert }) => {
    const { root, choices } = await fixture()
    await writeFile(join(root, '.env.account-kit.example'), 'owner value\n')
    const state = await inspectSetup(root)
    const plan = await planSetup(choices, state, { apply: true, timestamp: 1234 })
    assert.include(
      plan.diagnostics.map(({ field }) => field),
      '.env.account-kit.example'
    )
    await assert.rejects(() => applySetup(root, plan), /Setup has blocking diagnostics/)
    assert.notInclude(await readdir(join(root, 'config')), 'account_kit_setup.json')
    assert.equal(await readFile(join(root, '.env.account-kit.example'), 'utf8'), 'owner value\n')
  })

  test('replays an interrupted run and leaves application files untouched', async ({ assert }) => {
    const { root, choices } = await fixture()
    const originalRoutes = await readFile(join(root, 'start/routes.ts'), 'utf8')
    const first = await planSetup(choices, await inspectSetup(root), {
      apply: true,
      timestamp: 1234,
    })
    assert.isFalse(first.diagnostics.some(({ severity }) => severity === 'error'))
    await writeFile(join(root, first.changes[0].path), first.changes[0].content)
    const resumed = await planSetup(choices, await inspectSetup(root), {
      apply: true,
      timestamp: 1234,
    })
    assert.equal(resumed.changes[0].action, 'unchanged')
    const written = await applySetup(root, resumed)
    assert.lengthOf(written, 18)
    assert.include(await readFile(join(root, 'start/routes.ts'), 'utf8'), originalRoutes.trim())
    assert.include(
      await readFile(join(root, 'start/routes.ts'), 'utf8'),
      "import './account_kit_routes.js'"
    )
    const repeated = await planSetup(choices, await inspectSetup(root), {
      apply: true,
      timestamp: 4321,
    })
    assert.isTrue(repeated.changes.every(({ action }) => action === 'unchanged'))
    assert.deepEqual(await applySetup(root, repeated), [])
  })

  test('blocks unsupported guard, topology, password bounds and login retirement', async ({
    assert,
  }) => {
    const { root, choices } = await fixture()
    choices.managed.push('authentication')
    choices.features.push('authentication')
    choices.authentication = {
      strategy: 'session',
      guard: 'missing',
      session: { secureCookie: false, csrf: false, originChecked: false, persistentStore: false },
      applicationRouteRevocation: false,
    }
    choices.policy.password.minLength = 257
    const plan = await planSetup(choices, await inspectSetup(root), {
      apply: true,
      timestamp: 1234,
    })
    assert.includeMembers(
      plan.diagnostics.map(({ field }) => field),
      ['authentication.guard', 'authentication.applicationRouteRevocation', 'policy.password']
    )
    await assert.rejects(() => applySetup(root, plan), /Setup has blocking diagnostics/)
    await writeFile(join(root, 'config/account_kit_setup.json'), `${JSON.stringify(choices)}\n`)
    choices.features = ['passwordReset']
    choices.managed = []
    choices.authentication = null
    const retirement = await planSetup(choices, await inspectSetup(root), {
      apply: true,
      timestamp: 1234,
    })
    assert.include(
      retirement.diagnostics.map(({ field }) => field),
      'authentication.retirement'
    )
  })

  test('plans and applies a stock schema-composed starter with inert routes until application revocation is verified', async ({
    assert,
  }) => {
    const { root } = await fixture()
    const choices = parseSetupChoices(
      JSON.parse(
        await readFile(
          new URL('./fixtures/native_starter/setup-choices.json', import.meta.url),
          'utf8'
        )
      )
    )
    const stock = (path: string) =>
      readFile(new URL(`./fixtures/native_starter/${path}.fixture`, import.meta.url), 'utf8')
    for (const path of [
      'config/auth.ts',
      'config/mail.ts',
      'config/limiter.ts',
      'app/models/user.ts',
      'database/schema.ts',
    ]) {
      await mkdir(join(root, path.substring(0, path.lastIndexOf('/'))), { recursive: true })
      await writeFile(join(root, path), await stock(path))
    }
    await writeFile(join(root, '.env'), 'MAIL_MAILER=smtp\nLIMITER_STORE=database\n')
    await mkdir(join(root, 'node_modules/@adonisjs/mail'), { recursive: true })
    await writeFile(
      join(root, 'node_modules/@adonisjs/mail/package.json'),
      JSON.stringify({ name: '@adonisjs/mail', version: '10.0.0' })
    )
    const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
    manifest.dependencies['@adonisjs/mail'] = '10'
    manifest.imports = { '#models/*': './app/models/*.js', '#database/*': './database/*.js' }
    await writeFile(join(root, 'package.json'), JSON.stringify(manifest))
    const plan = await planSetup(choices, await inspectSetup(root), {
      apply: true,
      timestamp: 1234,
    })
    assert.isFalse(
      plan.diagnostics.some(({ severity }) => severity === 'error'),
      JSON.stringify(plan.diagnostics)
    )
    assert.isTrue(
      plan.diagnostics.some(
        ({ field, severity }) =>
          field === 'authentication.applicationRouteRevocation' && severity === 'action'
      )
    )
    assert.deepEqual(plan.endpointLocations, [])
    assert.isFalse(
      plan.changes
        .find(({ path }) => path === 'start/account_kit_routes.ts')
        ?.content.includes('registerManagedRoutes(')
    )
    await applySetup(root, plan)
    assert.notInclude(
      await readFile(join(root, 'start/account_kit_routes.ts'), 'utf8'),
      'registerManagedRoutes('
    )
    const replay = await planSetup(choices, await inspectSetup(root), {
      apply: true,
      timestamp: 1234,
    })
    assert.isFalse(
      replay.diagnostics.some(({ severity }) => severity === 'error'),
      JSON.stringify(replay.diagnostics)
    )
    assert.isTrue(replay.changes.every(({ action }) => action === 'unchanged'))
    assert.deepEqual(await applySetup(root, replay), [])
    const activeChoices = structuredClone(choices)
    activeChoices.authentication!.applicationRouteRevocation = true
    const activation = await planSetup(activeChoices, await inspectSetup(root), {
      apply: true,
      timestamp: 1234,
    })
    assert.isFalse(
      activation.diagnostics.some(({ severity }) => severity === 'error'),
      JSON.stringify(activation.diagnostics)
    )
    assert.include(
      activation.changes.find(({ path }) => path === 'start/account_kit_routes.ts')?.content,
      'registerManagedRoutes('
    )
    assert.equal(
      activation.changes.find(({ path }) => path === 'start/account_kit_routes.ts')?.action,
      'update'
    )
    await applySetup(root, activation)
    assert.include(
      await readFile(join(root, 'start/account_kit_routes.ts'), 'utf8'),
      'registerManagedRoutes('
    )
    assert.isFalse(activation.readiness.workflowVerified)
    const tokenChoices = structuredClone(activeChoices)
    tokenChoices.authentication = {
      strategy: 'access_tokens',
      guard: 'api',
      token: { revocation: true, lifetime: '1d', abilities: ['*'] },
      applicationRouteRevocation: true,
    }
    const tokenPlan = await planSetup(tokenChoices, await inspectSetup(root), {
      apply: true,
      timestamp: 1234,
    })
    assert.isFalse(
      tokenPlan.diagnostics.some(({ severity }) => severity === 'error'),
      JSON.stringify(tokenPlan.diagnostics)
    )
  })

  test('stock type augmentations stay safe while runtime config and schema mutations block setup', async ({
    assert,
  }) => {
    const { root, choices } = await fixture()
    const stock = (path: string) =>
      readFile(new URL(`./fixtures/native_starter/${path}.fixture`, import.meta.url), 'utf8')
    for (const path of [
      'config/auth.ts',
      'config/mail.ts',
      'config/limiter.ts',
      'app/models/user.ts',
      'database/schema.ts',
    ]) {
      await mkdir(join(root, path.substring(0, path.lastIndexOf('/'))), { recursive: true })
      await writeFile(join(root, path), await stock(path))
    }
    const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
    manifest.imports = { '#models/*': './app/models/*.js', '#database/*': './database/*.js' }
    await writeFile(join(root, 'package.json'), JSON.stringify(manifest))
    choices.mail.integration = 'adonisjs-mail'
    choices.mail.senderEnv = 'MAIL_FROM_ADDRESS'
    choices.mail.transportEnv = 'MAIL_MAILER'
    await writeFile(join(root, '.env'), 'MAIL_MAILER=smtp\nLIMITER_STORE=database\n')
    choices.authentication!.applicationRouteRevocation = true
    for (const [path, mutation, field] of [
      ['config/auth.ts', 'authConfig.guards.web = null', 'authentication.guard'],
      ['config/mail.ts', 'mailConfig.mailers.smtp = null', 'config/mail.ts'],
      ['config/limiter.ts', 'limiterConfig.stores.database = null', 'config/limiter.ts'],
      ['database/schema.ts', "UserSchema.table = 'other'", 'user.connection'],
      [
        'database/schema.ts',
        "class Other extends UserSchema { static { Object.getPrototypeOf(this).table = 'members' } }",
        'user.connection',
      ],
      ['database/schema.ts', "BaseModel.table = 'other'", 'user.connection'],
      ['database/schema.ts', 'column.dateTime = () => null', 'user.connection'],
      ['app/models/user.ts', "User.table = 'other'", 'user.model'],
      [
        'app/models/user.ts',
        "class Other extends User { static { Object.getPrototypeOf(this).table = 'members' } }",
        'user.model',
      ],
      ['app/models/user.ts', "UserSchema.table = 'other'", 'user.connection'],
    ] as const) {
      await writeFile(join(root, path), `${await stock(path)}\n${mutation}\n`)
      const plan = await planSetup(choices, await inspectSetup(root), {
        apply: true,
        timestamp: 1234,
      })
      assert.isTrue(
        plan.diagnostics.some(
          ({ field: found, severity }) => found === field && severity === 'error'
        ),
        `${path}: ${JSON.stringify(plan.diagnostics)}`
      )
      await assert.rejects(() => applySetup(root, plan), /blocking diagnostics/)
      const configFiles = await readdir(join(root, 'config'))
      assert.isFalse(configFiles.includes('account_kit_setup.json'))
      await writeFile(join(root, path), await stock(path))
    }
    const schema = await stock('database/schema.ts')
    await writeFile(
      join(root, 'database/schema.ts'),
      schema.replaceAll(
        '@column({ isPrimary: true })\n  declare id: number',
        '@column()\n  declare id: number'
      )
    )
    const wrongId = await planSetup(choices, await inspectSetup(root), {
      apply: true,
      timestamp: 1234,
    })
    assert.isTrue(
      wrongId.diagnostics.some(
        ({ field, severity }) => field === 'user.idType' && severity === 'error'
      )
    )
    await assert.rejects(() => applySetup(root, wrongId), /blocking diagnostics/)
    for (const member of [
      '@column({ isPrimary: true }) get alternateId() { return 1 }',
      "static boot() { super.boot(); this.table = 'members' }",
      'static get $columnsDefinitions() { return new Map() }',
      'constructor() { super() }',
    ]) {
      await writeFile(
        join(root, 'database/schema.ts'),
        schema.replace(
          'export class UserSchema extends BaseModel {',
          `export class UserSchema extends BaseModel {\n  ${member}`
        )
      )
      const unsupported = await planSetup(choices, await inspectSetup(root), {
        apply: true,
        timestamp: 1234,
      })
      assert.isTrue(
        unsupported.diagnostics.some(
          ({ field, severity }) =>
            ['user.idType', 'user.connection'].includes(field) && severity === 'error'
        ),
        `${member}: ${JSON.stringify(unsupported.diagnostics)}`
      )
      await assert.rejects(() => applySetup(root, unsupported), /blocking diagnostics/)
    }
    await writeFile(
      join(root, 'database/schema.ts'),
      schema.replace(
        'export class UserSchema extends BaseModel {',
        "export class UserSchema extends BaseModel {\n  static primaryKey = 'email'"
      )
    )
    const inheritedKey = await planSetup(choices, await inspectSetup(root), {
      apply: true,
      timestamp: 1234,
    })
    assert.isTrue(
      inheritedKey.diagnostics.some(
        ({ field, severity }) => field === 'user.idType' && severity === 'error'
      )
    )
    for (const decorator of ['column', 'column.date', 'column.dateTime']) {
      await writeFile(
        join(root, 'database/schema.ts'),
        schema.replace(
          "static $columns = ['createdAt', 'email', 'fullName', 'id', 'password', 'updatedAt'] as const",
          `static $columns = ['createdAt', 'email', 'fullName', 'id', 'password', 'updatedAt'] as const\n  @${decorator}({ isPrimary: true }) declare alternateId: number`
        )
      )
      const secondPrimary = await planSetup(choices, await inspectSetup(root), {
        apply: true,
        timestamp: 1234,
      })
      assert.isTrue(
        secondPrimary.diagnostics.some(
          ({ field, severity }) => field === 'user.idType' && severity === 'error'
        )
      )
      await assert.rejects(() => applySetup(root, secondPrimary), /blocking diagnostics/)
    }
    const user = await stock('app/models/user.ts')
    await writeFile(join(root, 'database/schema.ts'), schema)
    await writeFile(
      join(root, 'app/models/user.ts'),
      user.replace('static accessTokens =', "static primaryKey = 'email'\n  static accessTokens =")
    )
    const modelKey = await planSetup(choices, await inspectSetup(root), {
      apply: true,
      timestamp: 1234,
    })
    assert.isTrue(
      modelKey.diagnostics.some(
        ({ field, severity }) => field === 'user.idType' && severity === 'error'
      )
    )
    await writeFile(
      join(root, 'app/models/user.ts'),
      user.replace(
        'static accessTokens =',
        "static get primaryKey() { return 'email' }\n  static accessTokens ="
      )
    )
    const keyAccessor = await planSetup(choices, await inspectSetup(root), {
      apply: true,
      timestamp: 1234,
    })
    assert.isTrue(
      keyAccessor.diagnostics.some(
        ({ field, severity }) => field === 'user.model' && severity === 'error'
      )
    )
    for (const decorator of [
      '@column() declare id: number',
      '@column({ isPrimary: true }) declare alternateId: number',
    ]) {
      await writeFile(
        join(root, 'app/models/user.ts'),
        "import { column } from '@adonisjs/lucid/orm'\n" +
          user.replace('static accessTokens =', `${decorator}\n  static accessTokens =`)
      )
      const override = await planSetup(choices, await inspectSetup(root), {
        apply: true,
        timestamp: 1234,
      })
      assert.isTrue(
        override.diagnostics.some(
          ({ field, severity }) => field === 'user.idType' && severity === 'error'
        )
      )
      await assert.rejects(() => applySetup(root, override), /blocking diagnostics/)
    }
    const validIdOverride =
      "import { column } from '@adonisjs/lucid/orm'\n" +
      user.replace(
        'static accessTokens =',
        '@column({ isPrimary: true }) declare id: number\n  static accessTokens ='
      )
    await writeFile(join(root, 'app/models/user.ts'), validIdOverride)
    const sameId = await planSetup(choices, await inspectSetup(root), {
      apply: true,
      timestamp: 1234,
    })
    assert.isFalse(
      sameId.diagnostics.some(
        ({ field, severity }) => field === 'user.idType' && severity === 'error'
      )
    )
    await writeFile(
      join(root, 'app/models/user.ts'),
      `${validIdOverride}\ncolumn.dateTime = () => null\n`
    )
    const changedFactory = await planSetup(choices, await inspectSetup(root), {
      apply: true,
      timestamp: 1234,
    })
    assert.isTrue(
      changedFactory.diagnostics.some(
        ({ field, severity }) => field === 'user.idType' && severity === 'error'
      )
    )
    await assert.rejects(() => applySetup(root, changedFactory), /blocking diagnostics/)
    await writeFile(join(root, 'app/models/user.ts'), user)
    for (const idType of ['string', 'uuid'] as const) {
      await writeFile(
        join(root, 'database/schema.ts'),
        schema.replaceAll('declare id: number', 'declare id: string')
      )
      choices.user.idType = idType
      const matching = await planSetup(choices, await inspectSetup(root), {
        apply: true,
        timestamp: 1234,
      })
      assert.isFalse(
        matching.diagnostics.some(
          ({ field, severity }) => field === 'user.idType' && severity === 'error'
        ),
        JSON.stringify(matching.diagnostics)
      )
    }
    choices.user.idType = 'integer'
    const mismatchedType = await planSetup(choices, await inspectSetup(root), {
      apply: true,
      timestamp: 1234,
    })
    assert.isTrue(
      mismatchedType.diagnostics.some(
        ({ field, severity }) => field === 'user.idType' && severity === 'error'
      )
    )
    await writeFile(
      join(root, 'database/schema.ts'),
      schema.replaceAll(
        '@column({ isPrimary: true })',
        "@column({ isPrimary: true, columnName: 'other_id' })"
      )
    )
    const wrongColumn = await planSetup(choices, await inspectSetup(root), {
      apply: true,
      timestamp: 1234,
    })
    assert.isTrue(
      wrongColumn.diagnostics.some(
        ({ field, severity }) => field === 'user.idType' && severity === 'error'
      )
    )
    await writeFile(
      join(root, 'database/schema.ts'),
      schema.replace(
        'export class UserSchema extends BaseModel {',
        'export class UserSchema extends BaseModel {\n  static table = unknownTable'
      )
    )
    const unknownTable = await planSetup(choices, await inspectSetup(root), {
      apply: true,
      timestamp: 1234,
    })
    assert.isTrue(
      unknownTable.diagnostics.some(
        ({ field, severity }) => field === 'user.table' && severity === 'error'
      )
    )
    await writeFile(
      join(root, 'database/schema.ts'),
      schema.replace(
        'export class UserSchema extends BaseModel {',
        "export class UserSchema extends BaseModel {\n  static table = 'members'"
      )
    )
    choices.user.table = 'members'
    const schemaTable = await planSetup(choices, await inspectSetup(root), {
      apply: true,
      timestamp: 1234,
    })
    assert.isTrue(
      schemaTable.diagnostics.some(
        ({ field, severity }) => field === 'user.table' && severity === 'error'
      )
    )
    choices.user.table = 'users'
    const defaultUserTable = await planSetup(choices, await inspectSetup(root), {
      apply: true,
      timestamp: 1234,
    })
    assert.isFalse(
      defaultUserTable.diagnostics.some(
        ({ field, severity }) => field === 'user.table' && severity === 'error'
      )
    )
    await writeFile(
      join(root, 'database/schema.ts'),
      schema.replace(
        'export class UserSchema extends BaseModel {',
        "export class UserSchema extends BaseModel {\n  static connection = 'archive'"
      )
    )
    const inheritedConnection = await planSetup(choices, await inspectSetup(root), {
      apply: true,
      timestamp: 1234,
    })
    assert.isTrue(
      inheritedConnection.diagnostics.some(
        ({ field, severity }) => field === 'user.connection' && severity === 'error'
      )
    )
    await writeFile(
      join(root, 'database/schema.ts'),
      schema.replace(
        'export class UserSchema extends BaseModel {',
        'export class UserSchema extends BaseModel {\n  static namingStrategy = customNaming'
      )
    )
    const inheritedNaming = await planSetup(choices, await inspectSetup(root), {
      apply: true,
      timestamp: 1234,
    })
    assert.isTrue(
      inheritedNaming.diagnostics.some(
        ({ field, severity }) => field === 'user.idType' && severity === 'error'
      )
    )
    await writeFile(
      join(root, 'database/schema.ts'),
      schema.replace(
        'export class UserSchema extends BaseModel {',
        "export class UserSchema extends BaseModel {\n  static table = 'members'"
      )
    )
    await writeFile(
      join(root, 'app/models/user.ts'),
      user.replace('static accessTokens =', "static table = 'members'\n  static accessTokens =")
    )
    choices.user.table = 'members'
    const ownedTable = await planSetup(choices, await inspectSetup(root), {
      apply: true,
      timestamp: 1234,
    })
    assert.isFalse(
      ownedTable.diagnostics.some(
        ({ field, severity }) => field === 'user.table' && severity === 'error'
      )
    )
    await writeFile(join(root, 'app/models/user.ts'), user)
    choices.user.table = 'users'
    await writeFile(join(root, 'database/schema.ts'), schema)
    manifest.imports = { '#database/*': './elsewhere/*.js' }
    await writeFile(join(root, 'package.json'), JSON.stringify(manifest))
    const remapped = await planSetup(choices, await inspectSetup(root), {
      apply: true,
      timestamp: 1234,
    })
    assert.isTrue(
      remapped.diagnostics.some(
        ({ field, severity }) => field === 'user.connection' && severity === 'error'
      )
    )
    await assert.rejects(() => applySetup(root, remapped), /blocking diagnostics/)
    manifest.imports = { '#database/*': './database/*.js', '#database/s*': './elsewhere/*.js' }
    await writeFile(join(root, 'package.json'), JSON.stringify(manifest))
    const shadowedAlias = await planSetup(choices, await inspectSetup(root), {
      apply: true,
      timestamp: 1234,
    })
    assert.isTrue(
      shadowedAlias.diagnostics.some(
        ({ field, severity }) => field === 'user.connection' && severity === 'error'
      )
    )
  }).timeout(10_000)

  test('schema-composed model inspection refuses a linked schema leaf', async ({ assert }) => {
    const { root, choices } = await fixture()
    const outside = await mkdtemp(join(tmpdir(), 'account-schema-outside-'))
    cleanupRoots.push(outside)
    await mkdir(join(root, 'database'), { recursive: true })
    await writeFile(
      join(root, 'app/models/user.ts'),
      await readFile(
        new URL('./fixtures/native_starter/app/models/user.ts.fixture', import.meta.url),
        'utf8'
      )
    )
    const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
    manifest.imports = { '#models/*': './app/models/*.js', '#database/*': './database/*.js' }
    await writeFile(join(root, 'package.json'), JSON.stringify(manifest))
    const target = join(outside, 'schema.ts')
    await writeFile(
      target,
      await readFile(
        new URL('./fixtures/native_starter/database/schema.ts.fixture', import.meta.url),
        'utf8'
      )
    )
    await symlink(target, join(root, 'database/schema.ts'))
    const original = await readFile(target, 'utf8')
    const state = await inspectSetup(root)
    await assert.rejects(
      () => planSetup(choices, state, { apply: true, timestamp: 1234 }),
      /non-regular schema/
    )
    assert.equal(await readlink(join(root, 'database/schema.ts')), target)
    assert.equal(await readFile(target, 'utf8'), original)
  })

  test('direct Lucid models enforce the same physical id, decorator and runtime-hook boundary', async ({
    assert,
  }) => {
    const { root, choices } = await fixture()
    const path = join(root, 'app/models/user.ts')
    const direct = (id: 'number' | 'string') =>
      `import { BaseModel, column } from '@adonisjs/lucid/orm'\nexport default class User extends BaseModel { @column({ isPrimary: true }) declare id: ${id} }\n`
    for (const [idType, annotation] of [
      ['integer', 'number'],
      ['string', 'string'],
      ['uuid', 'string'],
    ] as const) {
      choices.user.idType = idType
      await writeFile(path, direct(annotation))
      const plan = await planSetup(choices, await inspectSetup(root), {
        apply: true,
        timestamp: 1234,
      })
      assert.isFalse(
        plan.diagnostics.some(
          ({ field, severity }) => field === 'user.idType' && severity === 'error'
        ),
        JSON.stringify(plan.diagnostics)
      )
    }
    choices.user.idType = 'integer'
    for (const source of [
      direct('string'),
      direct('number').replace(
        '@column({ isPrimary: true })',
        "@column({ isPrimary: true, columnName: 'other_id' })"
      ),
      direct('number').replace(
        'declare id: number',
        'declare id: number; @column({ isPrimary: true }) get alternateId() { return 1 }'
      ),
      direct('number').replace(
        'declare id: number',
        "declare id: number; static boot() { super.boot(); this.table = 'members' }"
      ),
      direct('number').replace(
        'declare id: number',
        'declare id: number; static get $columnsDefinitions() { return new Map() }'
      ),
      direct('number').replace(
        'declare id: number',
        'declare id: number; constructor() { super() }'
      ),
      direct('number').replace('declare id: number', 'declare id: number; static booted = true'),
      direct('number').replace('export default class User', '@custom\nexport default class User'),
    ]) {
      await writeFile(path, source)
      const plan = await planSetup(choices, await inspectSetup(root), {
        apply: true,
        timestamp: 1234,
      })
      assert.isTrue(
        plan.diagnostics.some(
          ({ field, severity }) =>
            ['user.idType', 'user.model'].includes(field) && severity === 'error'
        ),
        `${source}: ${JSON.stringify(plan.diagnostics)}`
      )
      await assert.rejects(() => applySetup(root, plan), /blocking diagnostics/)
      const configFiles = await readdir(join(root, 'config'))
      assert.notInclude(configFiles, 'account_kit_setup.json')
    }
  })

  test('model import-map redirects block planning and apply before writes', async ({ assert }) => {
    const { root, choices } = await fixture()
    const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
    for (const imports of [
      { '#models/*': './app/models/*.js', '#models/user': './elsewhere/user.js' },
      { '#models/*': './app/models/*.js', '#models/u*': './elsewhere/*.js' },
    ]) {
      manifest.imports = imports
      await writeFile(join(root, 'package.json'), JSON.stringify(manifest))
      const plan = await planSetup(choices, await inspectSetup(root), {
        apply: true,
        timestamp: 1234,
      })
      assert.isTrue(
        plan.diagnostics.some(
          ({ field, severity }) => field === 'user.model' && severity === 'error'
        )
      )
      await assert.rejects(() => applySetup(root, plan), /blocking diagnostics/)
      const configFiles = await readdir(join(root, 'config'))
      assert.notInclude(configFiles, 'account_kit_setup.json')
    }
  })

  test('model inheritance rejects unproved mixins and imported BaseModel mutations', async ({
    assert,
  }) => {
    const { root, choices } = await fixture()
    const modelPath = join(root, 'app/models/user.ts')
    await writeFile(
      modelPath,
      "import { BaseModel, column } from '@adonisjs/lucid/orm'\nimport { compose } from '@adonisjs/core/helpers'\nimport { withAuthFinder } from '@adonisjs/auth/mixins/lucid'\nimport hash from '@adonisjs/core/services/hash'\nexport default class User extends compose(BaseModel, withAuthFinder(hash)) { @column({ isPrimary: true }) declare id: number }\n"
    )
    const native = await planSetup(choices, await inspectSetup(root), {
      apply: true,
      timestamp: 1234,
    })
    assert.isFalse(
      native.diagnostics.some(
        ({ severity, field }) =>
          severity === 'error' && ['user.model', 'user.connection', 'user.idType'].includes(field)
      ),
      JSON.stringify(native.diagnostics)
    )
    for (const source of [
      "import { BaseModel, column } from '@adonisjs/lucid/orm'\nimport { compose } from '@adonisjs/core/helpers'\nconst arbitraryMixin = (superclass: typeof BaseModel) => class extends superclass { static boot() { super.boot(); this.table = 'members' } }\nexport default class User extends compose(BaseModel, arbitraryMixin) { @column({ isPrimary: true }) declare id: number }\n",
      "import { BaseModel, column } from '@adonisjs/lucid/orm'\nBaseModel.connection = 'archive'\nexport default class User extends BaseModel { @column({ isPrimary: true }) declare id: number }\n",
      "import { BaseModel, column } from '@adonisjs/lucid/orm'\nconst alias = BaseModel\nexport default class User extends BaseModel { @column({ isPrimary: true }) declare id: number }\n",
    ]) {
      await writeFile(modelPath, source)
      const plan = await planSetup(choices, await inspectSetup(root), {
        apply: true,
        timestamp: 1234,
      })
      assert.isTrue(
        plan.diagnostics.some(
          ({ severity, field }) =>
            severity === 'error' && ['user.model', 'user.connection'].includes(field)
        ),
        JSON.stringify(plan.diagnostics)
      )
      await assert.rejects(() => applySetup(root, plan), /blocking diagnostics/)
      const files = await readdir(join(root, 'config'))
      assert.notInclude(files, 'account_kit_setup.json')
    }
  })

  test('kernel and route service mutations block before generated middleware is written', async ({
    assert,
  }) => {
    const { root, choices } = await fixture()
    const kernel = await readFile(join(root, 'start/kernel.ts'), 'utf8')
    await writeFile(
      join(root, 'start/kernel.ts'),
      `${kernel}\nserver.errorHandler(() => import('#exceptions/handler'))\nexport const middleware = router.named({ auth: () => import('#middleware/auth_middleware') })\ndeclare module 'app/kernel' { type RouterService = typeof router; type ServerService = typeof server }\n`
    )
    const typedKernel = await planSetup(choices, await inspectSetup(root), {
      apply: true,
      timestamp: 1234,
    })
    assert.isFalse(
      typedKernel.diagnostics.some(
        ({ field, severity }) => field === 'start/kernel.ts' && severity === 'error'
      ),
      JSON.stringify(typedKernel.diagnostics)
    )
    for (const mutation of [
      'router.use = () => router',
      'server.use = () => server',
      'const alias = router',
      'const { use } = server',
      "const otherRouter = await import('@adonisjs/core/services/router')",
      "const otherServer = require('@adonisjs/core/services/server')",
    ]) {
      await writeFile(join(root, 'start/kernel.ts'), `${kernel}\n${mutation}\n`)
      const plan = await planSetup(choices, await inspectSetup(root), {
        apply: true,
        timestamp: 1234,
      })
      assert.isTrue(
        plan.diagnostics.some(
          ({ field, severity }) => field === 'start/kernel.ts' && severity === 'error'
        ),
        `${mutation}: ${JSON.stringify(plan.diagnostics)}`
      )
      await assert.rejects(() => applySetup(root, plan), /blocking diagnostics/)
      const files = await readdir(join(root, 'config'))
      assert.notInclude(files, 'account_kit_setup.json')
    }
    await writeFile(join(root, 'start/kernel.ts'), kernel)
    await writeFile(
      join(root, 'start/routes.ts'),
      "import router from '@adonisjs/core/services/router'\nrouter.get('/health', () => 'ok')\n"
    )
    const conventionalRoute = await planSetup(choices, await inspectSetup(root), {
      apply: true,
      timestamp: 1234,
    })
    assert.isFalse(
      conventionalRoute.diagnostics.some(
        ({ field, severity }) => field === 'start/routes.ts' && severity === 'error'
      ),
      JSON.stringify(conventionalRoute.diagnostics)
    )
    for (const mutation of [
      'router.get = () => router',
      'const alias = router',
      "const otherRouter = await import('@adonisjs/core/services/router')",
    ]) {
      await writeFile(
        join(root, 'start/routes.ts'),
        `import router from '@adonisjs/core/services/router'\n${mutation}\n`
      )
      const plan = await planSetup(choices, await inspectSetup(root), {
        apply: true,
        timestamp: 1234,
      })
      assert.isTrue(
        plan.diagnostics.some(
          ({ field, severity }) => field === 'start/routes.ts' && severity === 'error'
        ),
        `${mutation}: ${JSON.stringify(plan.diagnostics)}`
      )
      await assert.rejects(() => applySetup(root, plan), /blocking diagnostics/)
      const files = await readdir(join(root, 'config'))
      assert.notInclude(files, 'account_kit_setup.json')
    }
  })

  test('session backend follows its proven factory instead of its selected alias', async ({
    assert,
  }) => {
    const { root, choices } = await fixture()
    for (const [name, factory, blocked] of [
      ['cookie', 'database', false],
      ['database', 'cookie', true],
    ] as const) {
      await writeFile(
        join(root, 'config/session.ts'),
        `import { defineConfig, stores } from '@adonisjs/session'\nconst sessionConfig = defineConfig({ store: '${name}', stores: { ${name}: stores.${factory}() } })\nexport default sessionConfig\n`
      )
      const plan = await planSetup(choices, await inspectSetup(root), {
        apply: true,
        timestamp: 1234,
      })
      const sessionErrors = plan.diagnostics.filter(
        ({ field, severity }) => field === 'config/session.ts' && severity === 'error'
      )
      assert.equal(sessionErrors.length > 0, blocked, JSON.stringify(plan.diagnostics))
      if (blocked) {
        await assert.rejects(() => applySetup(root, plan), /blocking diagnostics/)
        const files = await readdir(join(root, 'config'))
        assert.notInclude(files, 'account_kit_setup.json')
      } else {
        assert.include(
          plan.changes.find(({ path }) => path === 'config/session.ts')!.content,
          'protectManagedSessionConfig'
        )
      }
    }
  })

  test('retirement uses a DB-derived count and a declared maintenance window', async ({
    assert,
  }) => {
    const { root, choices } = await fixture()
    const previous = structuredClone(choices)
    previous.features.push('authentication')
    previous.managed.push('authentication')
    await writeFile(join(root, 'config/account_kit_setup.json'), `${JSON.stringify(previous)}\n`)
    choices.authentication = null
    choices.managed = []
    const state = await inspectSetup(root)
    const impact = {
      inspectedAccounts: 9,
      affectedAccounts: 3,
      checkedAt: new Date().toISOString(),
    }
    const blocked = await planSetup(choices, state, { retirementImpact: impact })
    assert.include(
      blocked.diagnostics.find(({ field }) => field === 'authentication.retirement')!.message,
      '3 of 9'
    )
    const zero = { ...impact, affectedAccounts: 0 }
    const withoutWindow = await planSetup(choices, state, { retirementImpact: zero })
    assert.include(
      withoutWindow.diagnostics.map(({ field }) => field),
      'authentication.retirement'
    )
    const allowed = await planSetup(choices, state, {
      retirementImpact: zero,
      retirementMaintenanceWindow: true,
    })
    assert.notInclude(
      allowed.diagnostics.map(({ field }) => field),
      'authentication.retirement'
    )
    choices.authentication = previous.authentication
    const routeOnly = await planSetup(choices, state)
    assert.notInclude(
      routeOnly.diagnostics.map(({ field }) => field),
      'authentication.retirement'
    )
  })

  test('rejects insecure production origins without disclosing their values', async ({
    assert,
  }) => {
    const { root, choices } = await fixture()
    const previousApp = process.env.APP_URL
    const previousFrontend = process.env.FRONTEND_URL
    process.env.APP_URL = 'http://account.example.test/root/'
    process.env.FRONTEND_URL = 'http://account.example.test/'
    try {
      const plan = await planSetup(choices, await inspectSetup(root), { production: true })
      assert.includeMembers(
        plan.diagnostics.map(({ field }) => field),
        ['mail.backendOriginEnv', 'mail.frontendOriginEnv']
      )
      assert.isTrue(
        plan.diagnostics.some(
          ({ field, severity, message }) =>
            field === 'mail.frontendOriginEnv' && severity === 'error' && /HTTPS/i.test(message)
        )
      )
      assert.notInclude(JSON.stringify(plan.diagnostics), 'account.example.test')
      assert.isFalse(plan.readiness.productionReady)
    } finally {
      if (previousApp === undefined) delete process.env.APP_URL
      else process.env.APP_URL = previousApp
      if (previousFrontend === undefined) delete process.env.FRONTEND_URL
      else process.env.FRONTEND_URL = previousFrontend
    }
  })

  test('stops on an existing managed prefix and rejects hidden JSON fields', async ({ assert }) => {
    const { root, choices } = await fixture()
    await writeFile(
      join(root, 'start/routes.ts'),
      "import router from '@adonisjs/core/services/router'\nrouter.post('/account/auth/password-reset', handler)\n"
    )
    const plan = await planSetup(choices, await inspectSetup(root), {
      apply: true,
      timestamp: 1234,
    })
    assert.include(
      plan.diagnostics.map(({ field }) => field),
      'routePrefix'
    )
    await assert.rejects(() => applySetup(root, plan), /blocking diagnostics/)
    assert.throws(
      () => parseSetupChoices({ ...choices, privateApiKey: 'must-never-persist' }),
      /privateApiKey: unsupported field/
    )
    assert.notInclude(await readdir(join(root, 'config')), 'account_kit_setup.json')
  })

  test('a conflict introduced after planning still stops before the first write', async ({
    assert,
  }) => {
    const { root, choices } = await fixture()
    const plan = await planSetup(choices, await inspectSetup(root), {
      apply: true,
      timestamp: 1234,
    })
    const last = plan.changes.find(({ path }) => path.includes('_account_kit_'))!
    await mkdir(join(root, 'database/migrations'), { recursive: true })
    await writeFile(join(root, last.path), '// owner changed this migration\n')
    await assert.rejects(() => applySetup(root, plan), /Setup conflict/)
    assert.notInclude(await readdir(join(root, 'config')), 'account_kit_setup.json')
    assert.equal(await readFile(join(root, last.path), 'utf8'), '// owner changed this migration\n')
  })

  test('apply rejects a destination symlink before writing and preserves its target', async ({
    assert,
  }) => {
    const { root, choices } = await fixture()
    const outside = await mkdtemp(join(tmpdir(), 'account-setup-leaf-target-'))
    cleanupRoots.push(outside)
    const external = join(outside, 'owner.txt')
    const plan = await planSetup(choices, await inspectSetup(root), {
      apply: true,
      timestamp: 1234,
    })
    assert.isFalse(plan.diagnostics.some(({ severity }) => severity === 'error'))
    const change = plan.changes.find(({ path }) => path === 'config/account_kit_setup.json')!
    assert.equal(change.action, 'create')
    const linked = join(root, change.path)
    await writeFile(external, change.content)
    await symlink(external, linked)
    const before = await readdir(join(root, 'config'))
    await assert.rejects(() => applySetup(root, plan), /non-regular file/)
    assert.deepEqual(await readdir(join(root, 'config')), before)
    const linkedStat = await lstat(linked)
    assert.isTrue(linkedStat.isSymbolicLink())
    assert.equal(await readlink(linked), external)
    assert.equal(await readFile(external, 'utf8'), change.content)
    assert.notInclude(await readdir(root), '.account-kit-setup.lock')
  })

  test('temporary write failure stays unpublished and a competing create is never replaced', async ({
    assert,
  }) => {
    const { root, choices } = await fixture()
    const ordinary = await planSetup(choices, await inspectSetup(root), {
      apply: true,
      timestamp: 1234,
    })
    const target = 'app/atomic_account_kit_probe.txt'
    const plan = {
      ...ordinary,
      changes: [
        {
          path: target,
          action: 'create' as const,
          content: 'complete content\n',
          reason: 'Exercise atomic publication',
        },
      ],
    }
    await assert.rejects(
      () =>
        applySetup(root, plan, {
          beforePublish: async (temp) => {
            await writeFile(temp, 'partial')
            throw new Error('injected interruption')
          },
        }),
      /injected interruption/
    )
    const appFiles = await readdir(join(root, 'app'))
    assert.notInclude(appFiles, 'atomic_account_kit_probe.txt')
    assert.isFalse(appFiles.some((name) => name.includes('.account-kit-')))
    await assert.rejects(
      () =>
        applySetup(root, plan, {
          beforePublish: async (_temp, destination) => {
            await writeFile(destination, 'owner content\n')
          },
        }),
      /EEXIST/
    )
    assert.equal(await readFile(join(root, target), 'utf8'), 'owner content\n')
  })

  test('noninteractive Ace preview and apply use the same choices without prompting', async ({
    assert,
  }) => {
    const { root, choices } = await fixture()
    const input = join(root, 'choices.json')
    await writeFile(input, `${JSON.stringify(choices)}\n`)
    const ignitor = new IgnitorFactory()
      .withCoreProviders()
      .withCoreConfig()
      .merge({
        rcFileContents: {
          providers: [],
          commands: [async () => new ListLoader([SetupAccountKit])],
        },
      })
      .create(pathToFileURL(`${root}/`))
    await ignitor.ace().handle(['account-kit:setup', `--input=${input}`])
    assert.notInclude(await readdir(join(root, 'config')), 'account_kit_setup.json')
    await ignitor.ace().handle(['account-kit:setup', `--input=${input}`, '--apply'])
    assert.deepEqual(
      JSON.parse(await readFile(join(root, 'config/account_kit_setup.json'), 'utf8')),
      choices
    )
  })

  test('Ace reconfiguration obtains its retirement count before writing and fails closed on affected accounts', async ({
    assert,
  }) => {
    const { root, choices } = await fixture()
    const oldChoices = structuredClone(choices)
    oldChoices.features.push('authentication')
    await writeFile(join(root, 'config/account_kit_setup.json'), `${JSON.stringify(oldChoices)}\n`)
    choices.authentication = null
    choices.managed = []
    const input = join(root, 'retire.json')
    await writeFile(input, `${JSON.stringify(choices)}\n`)
    const ignitor = retirementIgnitor(root, async () => ({
      inspectedAccounts: 2,
      affectedAccounts: 1,
      checkedAt: new Date().toISOString(),
    }))
    const previousExitCode = process.exitCode
    try {
      await ignitor
        .ace()
        .handle([
          'account-kit:setup',
          `--input=${input}`,
          '--apply',
          '--retirement-maintenance-window',
        ])
    } finally {
      process.exitCode = previousExitCode
    }
    assert.deepEqual(
      JSON.parse(await readFile(join(root, 'config/account_kit_setup.json'), 'utf8')),
      oldChoices
    )
    assert.notInclude(await readdir(join(root, 'config')), 'account_kit.ts')
  })

  test('Ace retirement fails closed when its read-only inventory cannot query', async ({
    assert,
  }) => {
    const { root, choices } = await fixture()
    await writeFile(join(root, 'config/account_kit_setup.json'), `${JSON.stringify(choices)}\n`)
    choices.authentication = null
    choices.managed = []
    const input = join(root, 'retire.json')
    await writeFile(input, `${JSON.stringify(choices)}\n`)
    const ignitor = retirementIgnitor(root, async () => {
      throw new Error('database unavailable')
    })
    const previousExitCode = process.exitCode
    try {
      await ignitor
        .ace()
        .handle([
          'account-kit:setup',
          `--input=${input}`,
          '--apply',
          '--retirement-maintenance-window',
        ])
    } finally {
      process.exitCode = previousExitCode
    }
    assert.notInclude(await readdir(join(root, 'config')), 'account_kit.ts')
    const state = await inspectSetup(root)
    assert.isNotNull(state.existingChoices?.authentication)
  })

  test('Ace retirement applies after a zero-impact inventory in a maintenance window', async ({
    assert,
  }) => {
    const { root, choices } = await fixture()
    await writeFile(join(root, 'config/account_kit_setup.json'), `${JSON.stringify(choices)}\n`)
    choices.authentication = null
    choices.managed = []
    const input = join(root, 'retire.json')
    await writeFile(input, `${JSON.stringify(choices)}\n`)
    const ignitor = retirementIgnitor(root, async () => ({
      inspectedAccounts: 2,
      affectedAccounts: 0,
      checkedAt: new Date().toISOString(),
    }))
    await ignitor
      .ace()
      .handle([
        'account-kit:setup',
        `--input=${input}`,
        '--apply',
        '--retirement-maintenance-window',
      ])
    const state = await inspectSetup(root)
    assert.isNull(state.existingChoices?.authentication)
    assert.include(await readdir(join(root, 'config')), 'account_kit.ts')
  })

  test('service-only selection produces no managed route mount', async ({ assert }) => {
    const { root, choices } = await fixture()
    choices.mode = 'services'
    choices.managed = []
    choices.authentication = null
    const plan = await planSetup(choices, await inspectSetup(root), { timestamp: 1234 })
    assert.deepEqual(plan.endpoints, [])
    assert.notInclude(
      plan.changes.map(({ path }) => path),
      'start/account_kit_routes.ts'
    )
    assert.notInclude(plan.prerequisites.join(' '), 'guard prerequisites')
  })

  test('service-only setup ignores unrelated managed-prefix routes', async ({ assert }) => {
    const { root, choices } = await fixture()
    choices.mode = 'services'
    choices.managed = []
    choices.authentication = null
    await writeFile(
      join(root, 'start/routes.ts'),
      "import router from '@adonisjs/core/services/router'\nrouter.post('/account/auth/password-reset', handler)\n"
    )
    const plan = await planSetup(choices, await inspectSetup(root))
    assert.notInclude(
      plan.diagnostics.map(({ field }) => field),
      'routePrefix'
    )
  })

  test('setup preflight uses managed route overlap semantics and preserved constraints', async ({
    assert,
  }) => {
    const { root, choices } = await fixture()
    choices.features.push('authentication')
    choices.managed.push('authentication')
    await writeFile(
      join(root, 'start/routes.ts'),
      "import router from '@adonisjs/core/services/router'\nrouter.post('/account/auth/:action?', handler)\n"
    )
    const inspected = await inspectSetup(root)
    const inspectedPlan = await planSetup(choices, inspected)
    assert.include(
      inspectedPlan.diagnostics.map(({ field }) => field),
      'routePrefix'
    )
    const state = await inspectSetup(root)
    for (const [path, overlaps] of [
      ['/account/auth/:action?', true],
      ['/account/auth/*', true],
      ['/account/auth/:action-name', true],
      ['/account/auth/login/:tail?', true],
      ['/account/auth/login/*', false],
      ['/account/auth/login/:tail.json?', false],
    ] as const) {
      state.routeDefinitions = [{ method: 'POST', path }]
      const plan = await planSetup(choices, state)
      assert.equal(
        plan.diagnostics.some(({ field }) => field === 'routePrefix'),
        overlaps,
        path
      )
    }
    state.routeDefinitions = [
      { method: 'ANY', path: '/account/auth/:action?', name: 'application.catchAll' },
    ]
    const catchAll = await planSetup(choices, state)
    assert.include(
      catchAll.diagnostics.map(({ field }) => field),
      'routePrefix'
    )
    state.routeDefinitions = [
      {
        method: 'POST',
        path: '/account/auth/:id',
        matchers: { id: { match: /^[0-9]+$/ } },
      },
    ]
    const numeric = await planSetup(choices, state)
    assert.notInclude(
      numeric.diagnostics.map(({ field }) => field),
      'routePrefix'
    )
    state.routeDefinitions[0].matchers = { id: { match: /^login$/ } }
    const matching = await planSetup(choices, state)
    assert.include(
      matching.diagnostics.map(({ field }) => field),
      'routePrefix'
    )
  })

  test('persisted named exclusion supports an application-owned replacement across preview, apply and check', async ({
    assert,
  }) => {
    const { root, choices } = await fixture()
    choices.managedExcept = ['auth.passwordReset.request']
    await writeFile(
      join(root, 'start/routes.ts'),
      "import router from '@adonisjs/core/services/router'\nrouter.post('/account/auth/password-reset', handler)\n"
    )
    const preview = await planSetup(choices, await inspectSetup(root), { timestamp: 1234 })
    assert.notInclude(
      preview.diagnostics.map(({ field }) => field),
      'routePrefix'
    )
    assert.notInclude(preview.endpoints, 'auth.passwordReset.request')
    assert.include(preview.endpoints, 'auth.passwordReset.inspect')
    const applied = await planSetup(choices, await inspectSetup(root), {
      apply: true,
      timestamp: 1234,
    })
    await applySetup(root, applied)
    const persisted = await inspectSetup(root)
    assert.deepEqual(persisted.existingChoices?.managedExcept, ['auth.passwordReset.request'])
    assert.include(
      persisted.files['start/account_kit_routes.ts'],
      'except: ["auth.passwordReset.request"]'
    )
    const checked = await planSetup(persisted.existingChoices!, persisted, { timestamp: 1234 })
    assert.isFalse(checked.diagnostics.some(({ severity }) => severity === 'error'))
    assert.isTrue(checked.changes.every(({ action }) => action === 'unchanged'))
    choices.managedExcept = ['auth.passwordReset.request', 'auth.passwordReset.request']
    const invalid = await planSetup(choices, persisted)
    assert.include(
      invalid.diagnostics.map(({ field }) => field),
      'managedExcept'
    )
  })

  test('selected database client wins over unused connections', async ({ assert }) => {
    const { root, choices } = await fixture()
    await writeFile(
      join(root, 'config/database.ts'),
      "import { defineConfig } from '@adonisjs/lucid'\nexport default defineConfig({ connection: 'mysql', connections: { sqlite: { client: 'better-sqlite3' }, mysql: { client: 'mysql2' } } })\n"
    )
    const plan = await planSetup(choices, await inspectSetup(root))
    const state = await inspectSetup(root)
    assert.equal(state.database, 'unsupported')
    assert.include(
      plan.diagnostics.map(({ field }) => field),
      'database.client'
    )
  })

  test('rejects model leaf links and explicit table or connection mismatches', async ({
    assert,
  }) => {
    const { root, choices } = await fixture()
    const outside = join(tmpdir(), `account-kit-model-${Date.now()}.ts`)
    cleanupRoots.push(outside)
    await writeFile(outside, 'export default class User extends BaseModel {}\n')
    await rm(join(root, 'app/models/user.ts'))
    await symlink(outside, join(root, 'app/models/user.ts'))
    const linkedState = await inspectSetup(root)
    await assert.rejects(() => planSetup(choices, linkedState), /non-regular model/)
    await rm(join(root, 'app/models/user.ts'))
    await writeFile(
      join(root, 'app/models/user.ts'),
      "export default class User extends BaseModel { static table = 'members'; static connection = 'other' }\n"
    )
    const plan = await planSetup(choices, await inspectSetup(root))
    assert.includeMembers(
      plan.diagnostics.map(({ field }) => field),
      ['user.table', 'user.connection']
    )
  })

  test('detects manual mounts but ignores commented route and provider imports', async ({
    assert,
  }) => {
    const { root, choices } = await fixture()
    await writeFile(join(root, 'start/routes.ts'), "// import './account_kit_routes.js'\n")
    await writeFile(
      join(root, 'adonisrc.ts'),
      "// providers: [ ignored ]\nexport default { providers: [ /* () => import('@adonisjs/limiter/limiter_provider') */ ] }\n"
    )
    const plan = await planSetup(choices, await inspectSetup(root))
    assert.equal(plan.changes.find(({ path }) => path === 'start/routes.ts')?.action, 'update')
    assert.include(
      plan.changes.find(({ path }) => path === 'adonisrc.ts')!.content,
      "    () => import('@adonisjs/limiter/limiter_provider'),"
    )
    assert.include(
      plan.changes.find(({ path }) => path === 'adonisrc.ts')!.content,
      '// providers: [ ignored ]\nexport default { providers: [\n'
    )
    await writeFile(join(root, 'start/routes.ts'), 'registerManagedRoutes(router, {})\n')
    const duplicate = await planSetup(choices, await inspectSetup(root))
    assert.include(
      duplicate.diagnostics.map(({ field }) => field),
      'start/routes.ts'
    )
  })

  test('requires configured limiter and repairs a comma-free router array', async ({ assert }) => {
    const { root, choices } = await fixture()
    await rm(join(root, 'config/limiter.ts'))
    const missing = await planSetup(choices, await inspectSetup(root))
    assert.include(
      missing.diagnostics.map(({ field }) => field),
      'config/limiter.ts'
    )
    await writeFile(join(root, 'config/limiter.ts'), 'export default {}\n')
    const invalid = await planSetup(choices, await inspectSetup(root))
    assert.include(
      invalid.diagnostics.map(({ field }) => field),
      'config/limiter.ts'
    )
    await writeFile(join(root, 'config/limiter.ts'), 'export default defineConfig({})\n')
    await writeFile(
      join(root, 'start/kernel.ts'),
      "import router from '@adonisjs/core/services/router'\nimport server from '@adonisjs/core/services/server'\nserver.use([])\nrouter.use([\n  () => import('@adonisjs/core/bodyparser_middleware')\n])\n"
    )
    const planned = await planSetup(choices, await inspectSetup(root))
    const kernel = planned.changes.find(({ path }) => path === 'start/kernel.ts')!.content
    assert.include(kernel, "bodyparser_middleware'),\n  () => import('@adonisjs/session")
    assert.include(
      kernel,
      "server.use([\n  () => import('#middleware/account_kit_proof_headers_middleware'),"
    )
  })

  test('maintained mail needs explicit deployment configuration and cannot claim durable delivery', async ({
    assert,
  }) => {
    const { root, choices } = await fixture()
    choices.mail.integration = 'adonisjs-mail'
    choices.mail.senderEnv = 'ACCOUNT_MAIL_FROM'
    choices.mail.transportEnv = 'MAIL_MAILER'
    choices.mail.delivery = 'durable'
    choices.mail.durableWorkerVerified = true
    const plan = await planSetup(choices, await inspectSetup(root), {
      apply: true,
      timestamp: 1234,
    })
    assert.includeMembers(
      plan.diagnostics.map(({ field }) => field),
      ['mail.delivery', 'config/mail.ts', 'dependencies.@adonisjs/mail']
    )
    await assert.rejects(() => applySetup(root, plan), /blocking diagnostics/)
    assert.include(
      plan.changes.find(({ path }) => path === 'config/account_kit.ts')!.content,
      'createMailNotifications'
    )
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

  test('dynamic Shield CSRF requires a runtime check before session readiness', async ({
    assert,
  }) => {
    const { root, choices } = await fixture()
    choices.authentication!.strategy = 'session'
    await writeFile(
      join(root, 'config/shield.ts'),
      "export default { csrf: { enabled: env.get('ACCOUNT_KIT_AUTH_STRATEGY') === 'session' } }\n"
    )
    const plan = await planSetup(choices, await inspectSetup(root))
    assert.isTrue(
      plan.diagnostics.some(
        (item) => item.field === 'config/shield.ts' && item.severity === 'action'
      )
    )
    assert.isFalse(plan.readiness.externalConfigured)
    assert.isTrue(plan.prerequisites.some((item) => item.includes('CSRF-protected POST')))
  })

  test('session planning rejects cookie replay and unconfigured stores', async ({ assert }) => {
    const { root, choices } = await fixture()
    await writeFile(
      join(root, 'config/session.ts'),
      "import env from '#start/env'\nexport default { store: env.get('SESSION_DRIVER'), stores: { cookie: stores.cookie(), database: stores.database() } }\n"
    )
    const previous = process.env.SESSION_DRIVER
    try {
      process.env.SESSION_DRIVER = 'cookie'
      const cookie = await planSetup(choices, await inspectSetup(root))
      assert.isTrue(
        cookie.diagnostics.some(
          (item) => item.field === 'config/session.ts' && item.severity === 'error'
        )
      )
      process.env.SESSION_DRIVER = 'memory'
      const missing = await planSetup(choices, await inspectSetup(root))
      assert.isTrue(missing.diagnostics.some((item) => item.message.includes('not configured')))
      process.env.SESSION_DRIVER = 'database'
      const database = await planSetup(choices, await inspectSetup(root))
      assert.isTrue(
        database.diagnostics.some(
          (item) => item.message.includes('session-table migration') && item.severity === 'action'
        )
      )
    } finally {
      if (previous === undefined) delete process.env.SESSION_DRIVER
      else process.env.SESSION_DRIVER = previous
    }
  })

  test('reconfiguration reports changed fields and updates only owned files', async ({
    assert,
  }) => {
    const { root, choices } = await fixture()
    const initial = await planSetup(choices, await inspectSetup(root), {
      apply: true,
      timestamp: 1234,
    })
    await applySetup(root, initial)
    const routesBefore = await readFile(join(root, 'start/routes.ts'), 'utf8')
    choices.routePrefix = '/members'
    const next = await planSetup(choices, await inspectSetup(root), {
      apply: true,
      timestamp: 4321,
    })
    assert.include(next.differences, 'routePrefix')
    assert.equal(
      next.changes.find(({ path }) => path === 'config/account_kit_setup.json')!.action,
      'update'
    )
    assert.equal(
      next.changes.find(({ path }) => path === 'start/account_kit_routes.ts')!.action,
      'update'
    )
    await applySetup(root, next)
    assert.equal(await readFile(join(root, 'start/routes.ts'), 'utf8'), routesBefore)
    assert.include(await readFile(join(root, 'start/account_kit_routes.ts'), 'utf8'), '"/members"')
  })

  test('disabling the last managed group retires its mount while keeping application routes', async ({
    assert,
  }) => {
    const { root, choices } = await fixture()
    const initial = await planSetup(choices, await inspectSetup(root), {
      apply: true,
      timestamp: 1234,
    })
    await applySetup(root, initial)
    const routesBefore = await readFile(join(root, 'start/routes.ts'), 'utf8')
    choices.managed = []
    const next = await planSetup(choices, await inspectSetup(root), {
      apply: true,
      timestamp: 1234,
    })
    const mount = next.changes.find(({ path }) => path === 'start/account_kit_routes.ts')!
    assert.equal(mount.action, 'update')
    assert.notInclude(mount.content, 'registerManagedRoutes')
    await applySetup(root, next)
    assert.equal(await readFile(join(root, 'start/routes.ts'), 'utf8'), routesBefore)
    assert.equal(await readFile(join(root, 'start/account_kit_routes.ts'), 'utf8'), mount.content)
    assert.deepEqual(next.endpoints, [])
    choices.managed = ['passwordReset']
    choices.authentication!.guard = 'api'
    choices.authentication!.strategy = 'access_tokens'
    delete choices.authentication!.session
    choices.authentication!.token = { revocation: true, lifetime: '7d', abilities: ['*'] }
    const enabled = await planSetup(choices, await inspectSetup(root), {
      apply: true,
      timestamp: 1234,
    })
    assert.equal(
      enabled.changes.find(({ path }) => path === 'start/account_kit_routes.ts')!.action,
      'update'
    )
    await applySetup(root, enabled)
    assert.include(
      await readFile(join(root, 'start/account_kit_routes.ts'), 'utf8'),
      'registerManagedRoutes'
    )
  })

  test('disabled choices retain exact owned baselines through re-enable and reject edits', async ({
    assert,
  }) => {
    const { root, choices } = await fixture()
    choices.features.push('emailVerification')
    choices.mail.destinations.emailVerification = 'account/verify'
    await applySetup(
      root,
      await planSetup(choices, await inspectSetup(root), { apply: true, timestamp: 1234 })
    )
    choices.managed = []
    choices.policy.verificationRequired = true
    choices.authentication!.guard = 'api'
    choices.authentication!.strategy = 'access_tokens'
    delete choices.authentication!.session
    choices.authentication!.token = { revocation: true, lifetime: '1d', abilities: ['*'] }
    const disabled = await planSetup(choices, await inspectSetup(root), {
      apply: true,
      timestamp: 1234,
    })
    assert.equal(
      disabled.changes.find(({ path }) => path === 'app/services/account_kit_guard.ts')?.action,
      'update'
    )
    assert.equal(
      disabled.changes.find(
        ({ path }) => path === 'app/middleware/account_kit_access_middleware.ts'
      )?.action,
      'update'
    )
    await applySetup(root, disabled)
    choices.managed = ['passwordReset']
    const restored = await planSetup(choices, await inspectSetup(root), {
      apply: true,
      timestamp: 1234,
    })
    assert.isFalse(restored.diagnostics.some(({ severity }) => severity === 'error'))
    await applySetup(root, restored)
    choices.managed = []
    choices.authentication = null
    const zero = { inspectedAccounts: 1, affectedAccounts: 0, checkedAt: new Date().toISOString() }
    await applySetup(
      root,
      await planSetup(choices, await inspectSetup(root), {
        apply: true,
        timestamp: 1234,
        retirementImpact: zero,
        retirementMaintenanceWindow: true,
      })
    )
    choices.authentication = {
      strategy: 'access_tokens',
      guard: 'api',
      token: { revocation: true, lifetime: '1d', abilities: ['*'] },
      applicationRouteRevocation: true,
    }
    choices.managed = ['passwordReset']
    const reenabling = await planSetup(choices, await inspectSetup(root), {
      apply: true,
      timestamp: 1234,
    })
    assert.isFalse(reenabling.diagnostics.some(({ severity }) => severity === 'error'))
    await applySetup(root, reenabling)
    await writeFile(join(root, 'app/services/account_kit_guard.ts'), '// owner edit\n')
    choices.authentication.guard = 'web'
    const conflicted = await planSetup(choices, await inspectSetup(root), {
      apply: true,
      timestamp: 1234,
    })
    assert.equal(
      conflicted.changes.find(({ path }) => path === 'app/services/account_kit_guard.ts')?.action,
      'conflict'
    )
  })

  test('reconfiguration replay keeps old choices until dependent files finish', async ({
    assert,
  }) => {
    const { root, choices } = await fixture()
    await applySetup(
      root,
      await planSetup(choices, await inspectSetup(root), { apply: true, timestamp: 1234 })
    )
    choices.routePrefix = '/new-account'
    const proposed = await planSetup(choices, await inspectSetup(root), {
      apply: true,
      timestamp: 1234,
    })
    assert.equal(proposed.changes.at(-1)?.path, 'config/account_kit_setup.json')
    await applySetup(root, { ...proposed, changes: proposed.changes.slice(0, 2) })
    const retry = await planSetup(choices, await inspectSetup(root), {
      apply: true,
      timestamp: 1234,
    })
    assert.isFalse(retry.diagnostics.some(({ severity }) => severity === 'error'))
    await applySetup(root, retry)
    assert.equal(
      JSON.parse(await readFile(join(root, 'config/account_kit_setup.json'), 'utf8')).routePrefix,
      '/new-account'
    )
  })

  test('inspection refuses linked parent paths and setup refuses an existing apply lock', async ({
    assert,
  }) => {
    const { root, choices } = await fixture()
    const outside = await mkdtemp(join(tmpdir(), 'account-outside-'))
    cleanupRoots.push(outside)
    await rm(join(root, 'app/models'), { recursive: true })
    await symlink(outside, join(root, 'app/models'))
    await assert.rejects(
      async () => planSetup(choices, await inspectSetup(root)),
      /non-directory or symlink/
    )
    const other = await fixture()
    const plan = await planSetup(other.choices, await inspectSetup(other.root), {
      apply: true,
      timestamp: 1234,
    })
    await writeFile(join(other.root, '.account-kit-setup.lock'), 'held elsewhere\n')
    await assert.rejects(() => applySetup(other.root, plan), /already applying or was interrupted/)
    assert.notInclude(await readdir(join(other.root, 'config')), 'account_kit_setup.json')
    const migration = await fixture()
    await mkdir(join(migration.root, 'database'))
    await symlink(outside, join(migration.root, 'database/migrations'))
    await assert.rejects(() => inspectSetup(migration.root), /non-directory or symlink/)
  })

  test('planner checks installed versions, guard driver, and named default connection', async ({
    assert,
  }) => {
    const { root, choices } = await fixture()
    await writeFile(
      join(root, 'config/database.ts'),
      "import { defineConfig } from '@adonisjs/lucid'\nexport default defineConfig({ connection: 'sqlite', connections: { sqlite: { client: 'better-sqlite3' } } })\n"
    )
    let plan = await planSetup(choices, await inspectSetup(root), { timestamp: 1234 })
    assert.notInclude(
      plan.diagnostics.map(({ field }) => field),
      'database.connection'
    )
    await writeFile(
      join(root, 'node_modules/@adonisjs/limiter/package.json'),
      JSON.stringify({ version: '2.0.0' })
    )
    await writeFile(
      join(root, 'config/auth.ts'),
      "import { defineConfig } from '@adonisjs/auth'\nimport { tokensGuard } from '@adonisjs/auth/access_tokens'\nexport default defineConfig({ guards: { web: tokensGuard({})\n} })\n"
    )
    plan = await planSetup(choices, await inspectSetup(root), { timestamp: 1234 })
    assert.includeMembers(
      plan.diagnostics.map(({ field }) => field),
      ['dependencies.@adonisjs/limiter', 'authentication.guard']
    )
    await rm(join(root, 'node_modules/@adonisjs/limiter/package.json'))
    plan = await planSetup(choices, await inspectSetup(root), { timestamp: 1234 })
    assert.include(
      plan.diagnostics.map(({ field }) => field),
      'dependencies.@adonisjs/limiter'
    )
  })

  test('inspects both conventional guards across nested provider objects', async ({ assert }) => {
    const { root, choices } = await fixture()
    await writeFile(
      join(root, 'config/auth.ts'),
      `import { defineConfig } from '@adonisjs/auth'
import { sessionGuard, sessionUserProvider } from '@adonisjs/auth/session'
import { tokensGuard, tokensUserProvider } from '@adonisjs/auth/access_tokens'
export default defineConfig({
  guards: {
    api: tokensGuard({ provider: tokensUserProvider({ tokens: 'accessTokens', model: () => import('#models/user') }) }),
    web: sessionGuard({ provider: sessionUserProvider({ model: () => import('#models/user') }) }),
  },
})\n`
    )
    const state = await inspectSetup(root)
    assert.includeMembers(state.guards, ['api', 'web'])
    const plan = await planSetup(choices, state, { timestamp: 1234 })
    assert.notInclude(
      plan.diagnostics.map(({ field }) => field),
      'authentication.guard'
    )
  })

  test('resolves a selected named database from conventional multi-connection config', async ({
    assert,
  }) => {
    const { root } = await fixture()
    await writeFile(
      join(root, 'config/database.ts'),
      "import { defineConfig } from '@adonisjs/lucid'\nimport env from '#start/env'\nexport default defineConfig({ connection: env.get('DB_CONNECTION'), connections: { sqlite: { client: 'better-sqlite3' }, pg: { client: 'pg' } } })\n"
    )
    const before = process.env.DB_CONNECTION
    try {
      process.env.DB_CONNECTION = 'sqlite'
      const sqlite = await inspectSetup(root)
      assert.equal(sqlite.database, 'sqlite')
      process.env.DB_CONNECTION = 'pg'
      const postgres = await inspectSetup(root)
      assert.equal(postgres.database, 'postgres')
    } finally {
      if (before === undefined) delete process.env.DB_CONNECTION
      else process.env.DB_CONNECTION = before
    }
  })

  test('managed middleware follows body parsing and refuses a server middleware placement', async ({
    assert,
  }) => {
    const { root, choices } = await fixture()
    let plan = await planSetup(choices, await inspectSetup(root), { timestamp: 1234 })
    const kernel = plan.changes.find(({ path }) => path === 'start/kernel.ts')!.content
    assert.isBelow(kernel.indexOf('bodyparser_middleware'), kernel.indexOf('session_middleware'))
    assert.isBelow(kernel.indexOf('session_middleware'), kernel.indexOf('shield_middleware'))
    assert.isBelow(
      kernel.indexOf('shield_middleware'),
      kernel.indexOf('initialize_auth_middleware')
    )
    await writeFile(
      join(root, 'start/kernel.ts'),
      "import router from '@adonisjs/core/services/router'\nimport server from '@adonisjs/core/services/server'\nserver.use([() => import('@adonisjs/auth/initialize_auth_middleware')])\nrouter.use([() => import('@adonisjs/core/bodyparser_middleware')])\n"
    )
    plan = await planSetup(choices, await inspectSetup(root), { timestamp: 1234 })
    assert.include(
      plan.diagnostics.map(({ field }) => field),
      'start/kernel.ts'
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

  test('semantic setup choices reject invalid registration, duration and abilities', ({
    assert,
  }) => {
    const choices = defaultSetupChoices()
    choices.policy.registration = 'typo' as never
    assert.throws(() => parseSetupChoices(choices), /policy.registration/)
    choices.policy.registration = 'open'
    choices.authentication = {
      strategy: 'access_tokens',
      guard: 'api',
      token: { revocation: true, lifetime: 'nonsense', abilities: ['*'] },
      applicationRouteRevocation: true,
    }
    assert.throws(() => parseSetupChoices(choices), /authentication.token.lifetime/)
    choices.authentication.token!.lifetime = '7d'
    choices.authentication.token!.abilities = ['']
    assert.throws(() => parseSetupChoices(choices), /authentication.token.abilities/)
  })

  test('additional registration fields are explicit and protected properties are refused', async ({
    assert,
  }) => {
    const { root, choices } = await fixture()
    choices.features.push('registration')
    choices.policy.registration = 'open'
    choices.policy.registrationFields = [
      { name: 'fullName', type: 'string', required: true, maxLength: 120 },
    ]
    const plan = await planSetup(choices, await inspectSetup(root), { timestamp: 1234 })
    const config = plan.changes.find(({ path }) => path === 'config/account_kit.ts')!.content
    assert.include(config, 'mapFields: mapRegistrationFields')
    assert.include(config, 'mapRegistrationData: (data, user)')
    assert.include(config, 'registrationData.${key} is not allowed')
    assert.include(config, "import { InvalidInputError } from 'adonisjs-account-kit/errors'")
    assert.include(
      config,
      'throw new InvalidInputError(`account_kit: registrationData.${field.name} is required`)'
    )
    choices.policy.registrationFields.push({ name: 'Role', type: 'string', required: true })
    const blocked = await planSetup(choices, await inspectSetup(root), {
      apply: true,
      timestamp: 1234,
    })
    assert.include(
      blocked.diagnostics.map(({ field }) => field),
      'policy.registrationFields.1.name'
    )
    await assert.rejects(() => applySetup(root, blocked), /blocking diagnostics/)
  })

  if (process.env.TEST_BUILT_SETUP === '1') {
    test('built Ace command previews and applies packaged migration templates', async ({
      assert,
    }) => {
      const builtPath = '../build/commands/setup.js'
      const { default: BuiltSetup } = (await import(builtPath)) as {
        default: typeof SetupAccountKit
      }
      const { root, choices } = await fixture()
      const input = join(root, 'choices.json')
      await writeFile(input, JSON.stringify(choices))
      const ignitor = new IgnitorFactory()
        .withCoreProviders()
        .withCoreConfig()
        .merge({
          rcFileContents: { providers: [], commands: [async () => new ListLoader([BuiltSetup])] },
        })
        .create(pathToFileURL(`${root}/`))
      await ignitor.ace().handle(['account-kit:setup', `--input=${input}`])
      await ignitor.ace().handle(['account-kit:setup', `--input=${input}`, '--apply'])
      const migrations = await readdir(join(root, 'database/migrations'))
      assert.isAbove(migrations.filter((name) => name.includes('_account_kit_')).length, 0)
      assert.deepEqual(
        JSON.parse(await readFile(join(root, 'config/account_kit_setup.json'), 'utf8')),
        choices
      )
    })
  }
})
