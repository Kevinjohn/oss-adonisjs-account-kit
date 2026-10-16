import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
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
    "import { BaseModel } from '@adonisjs/lucid/orm'\nexport default class User extends BaseModel { static accessTokens = tokens; email!: string; password!: string; emailVerifiedAt!: Date }\n"
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

  test('accepts a model that inherits account fields from an application schema', async ({
    assert,
  }) => {
    const { root, choices } = await fixture()
    await writeFile(
      join(root, 'app/models/user.ts'),
      'export default class User extends UserSchema {}\n'
    )
    const plan = await planSetup(choices, await inspectSetup(root), { timestamp: 1234 })
    assert.notInclude(
      plan.diagnostics.map(({ field }) => field),
      'user.model.password'
    )
    assert.notInclude(
      plan.diagnostics.map(({ field }) => field),
      'user.model.emailVerifiedAt'
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
