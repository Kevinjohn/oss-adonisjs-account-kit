import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
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
    'class User { email!: string; password!: string; emailVerifiedAt!: Date }\n'
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
        '@adonisjs/core': '7',
        '@adonisjs/lucid': '22',
        'adonisjs-account-kit': '0',
      },
    })
  )
  await writeFile(
    join(root, 'config/auth.ts'),
    'export default { guards: { web: {}, api: {}\n} }\n'
  )
  await writeFile(join(root, 'config/database.ts'), "export default { client: 'better-sqlite3' }\n")
  await writeFile(join(root, 'config/shield.ts'), 'export default { csrf: { enabled: true } }\n')
  await writeFile(join(root, 'config/session.ts'), 'export default { cookie: {} }\n')
  await writeFile(join(root, 'adonisrc.ts'), 'export default { providers: [] }\n')
  await writeFile(join(root, 'start/routes.ts'), '// application routes\n')
  await writeFile(join(root, 'start/kernel.ts'), 'server.use([])\n')
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
      'auth.passwordReset.request',
      'auth.passwordReset.inspect',
      'auth.passwordReset.complete',
    ])
    assert.lengthOf(
      plan.changes.filter(({ action }) => action === 'create'),
      14
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
    assert.lengthOf(written, 16)
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
    const previousFrontend = process.env.ACCOUNT_FRONTEND_URL
    process.env.APP_URL = 'http://account.example.test/root/'
    process.env.ACCOUNT_FRONTEND_URL = 'http://account.example.test/'
    try {
      const plan = await planSetup(choices, await inspectSetup(root), { production: true })
      assert.includeMembers(
        plan.diagnostics.map(({ field }) => field),
        ['mail.backendOriginEnv', 'mail.frontendOriginEnv']
      )
      assert.notInclude(JSON.stringify(plan.diagnostics), 'account.example.test')
      assert.isFalse(plan.readiness.productionReady)
    } finally {
      if (previousApp === undefined) delete process.env.APP_URL
      else process.env.APP_URL = previousApp
      if (previousFrontend === undefined) delete process.env.ACCOUNT_FRONTEND_URL
      else process.env.ACCOUNT_FRONTEND_URL = previousFrontend
    }
  })

  test('stops on an existing managed prefix and rejects hidden JSON fields', async ({ assert }) => {
    const { root, choices } = await fixture()
    await writeFile(join(root, 'start/routes.ts'), "router.get('/account/profile', handler)\n")
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
    const last = plan.changes.at(-1)!
    await mkdir(join(root, 'database/migrations'), { recursive: true })
    await writeFile(join(root, last.path), '// owner changed this migration\n')
    await assert.rejects(() => applySetup(root, plan), /Setup conflict/)
    assert.notInclude(await readdir(join(root, 'config')), 'account_kit_setup.json')
    assert.equal(await readFile(join(root, last.path), 'utf8'), '// owner changed this migration\n')
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

  test('maintained mail needs explicit deployment configuration and cannot claim durable delivery', async ({
    assert,
  }) => {
    const { root, choices } = await fixture()
    choices.mail.integration = 'adonisjs-mail'
    choices.mail.senderEnv = 'ACCOUNT_MAIL_FROM'
    choices.mail.transportEnv = 'MAIL_MAILER'
    choices.mail.delivery = 'durable'
    choices.mail.durableWorkerVerified = true
    const plan = await planSetup(choices, await inspectSetup(root), { timestamp: 1234 })
    assert.includeMembers(
      plan.diagnostics.map(({ field }) => field),
      ['mail.delivery', 'config/mail.ts']
    )
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
})
