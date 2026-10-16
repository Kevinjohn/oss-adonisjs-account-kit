import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from '@japa/runner'
import ts from 'typescript'
import { defaultSetupChoices } from '../src/setup/defaults.js'
import { planSetup } from '../src/setup/plan.js'
import { stripSourceComments } from '../src/setup/source_text.js'
import type { SetupChoices, SetupInspection } from '../src/setup/types.js'

const versions: Record<string, string> = {
  '@adonisjs/core': '7.0.0',
  '@adonisjs/lucid': '22.4.2',
  '@adonisjs/limiter': '3.0.0',
  '@adonisjs/auth': '10.1.0',
  '@adonisjs/session': '8.1.0',
  '@adonisjs/shield': '9.0.0',
  '@vinejs/vine': '4.4.0',
  '@adonisjs/mail': '10.0.0',
  'adonisjs-account-kit': '0.0.0',
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'account-kit-prerequisites-'))
  await mkdir(join(root, 'app/models'), { recursive: true })
  await writeFile(
    join(root, 'app/models/user.ts'),
    'export default class User extends BaseModel {}'
  )
  const choices = defaultSetupChoices()
  choices.policy.accessRestrictionHook = true
  choices.mail.integration = 'custom'
  choices.mail.senderEnv = null
  choices.mail.transportEnv = null
  const state: SetupInspection = {
    root,
    existingInstallation: false,
    files: {
      'adonisrc.ts': 'export default { providers: [] }',
      'start/routes.ts': '// application routes',
      'start/kernel.ts':
        "server.use([() => import('@adonisjs/cors/cors_middleware')])\nrouter.use([() => import('@adonisjs/core/bodyparser_middleware')])",
      'config/shield.ts': 'export default { csrf: { enabled: true } }',
      'config/session.ts':
        "export default { store: 'database', stores: { database: stores.database() } }",
      'config/limiter.ts':
        "export default defineConfig({ default: 'memory', stores: { memory: stores.memory({}) } })",
      'app/services/account_kit_policy.ts': 'export const accountKitPolicy = {}',
      'app/services/account_kit_notifications.ts': 'export const accountKitNotifications = {}',
    },
    guards: ['web'],
    guardStrategies: { web: 'session' },
    guardModels: { web: '#models/user' },
    installedVersions: { ...versions },
    installedPackages: Object.keys(versions),
    database: 'sqlite',
    connection: 'default',
    migrationNames: ['create_sessions.ts'],
    existingPrefix: null,
    routePaths: [],
    routeDefinitions: [],
    existingChoices: null,
  }
  return { root, choices, state }
}

async function withFixture(
  run: (choices: SetupChoices, state: SetupInspection, root: string) => Promise<void>
) {
  const { root, choices, state } = await fixture()
  try {
    await run(choices, state, root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test.group('setup prerequisite inspection', () => {
  test('service-only proposal does not register Vine or require its package', async ({
    assert,
  }) => {
    await withFixture(async (choices, state) => {
      choices.mode = 'services'
      choices.managed = []
      choices.features = ['passwordReset']
      choices.authentication = null
      choices.policy.accessRestrictionHook = false
      state.installedPackages = state.installedPackages.filter((name) => name !== '@vinejs/vine')
      delete state.installedVersions['@vinejs/vine']
      const plan = await planSetup(choices, state)
      assert.notInclude(
        plan.diagnostics.map(({ field }) => field),
        'dependencies.@vinejs/vine'
      )
      assert.notInclude(
        plan.changes.find(({ path }) => path === 'adonisrc.ts')?.content ?? '',
        'vinejs_provider'
      )
    })
  })

  test('generated mapper with omitted maxLength is semantically type-safe', async ({ assert }) => {
    await withFixture(async (choices, state, root) => {
      choices.policy.registrationFields = [{ name: 'fullName', type: 'string', required: true }]
      const plan = await planSetup(choices, state)
      const config = plan.changes.find(({ path }) => path === 'config/account_kit.ts')!.content
      const mapper = config.slice(
        config.indexOf('const registrationFields:'),
        config.indexOf('const users =')
      )
      const file = join(root, 'mapper.ts')
      await writeFile(file, `class InvalidInputError extends Error {}\n${mapper}`)
      const program = ts.createProgram([file], {
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        target: ts.ScriptTarget.ES2022,
      })
      assert.deepEqual(
        ts
          .getPreEmitDiagnostics(program)
          .map((issue) => ts.flattenDiagnosticMessageText(issue.messageText, '\n')),
        []
      )
    })
  })

  test('rejects an aliased cookie session and leaves dynamic custom stores unverified', async ({
    assert,
  }) => {
    await withFixture(async (choices, state) => {
      state.files['config/session.ts'] =
        "export default { store: 'browser', stores: { browser: stores.cookie() } }"
      const cookie = await planSetup(choices, state)
      assert.isTrue(
        cookie.diagnostics.some(
          ({ field, message, severity }) =>
            field === 'config/session.ts' && severity === 'error' && message.includes('Cookie-only')
        )
      )
      state.files['config/session.ts'] =
        'export default { store: "browser", stores: { "browser": stores.cookie() } }'
      const quotedAlias = await planSetup(choices, state)
      assert.isTrue(
        quotedAlias.diagnostics.some(
          ({ field, message, severity }) =>
            field === 'config/session.ts' && severity === 'error' && message.includes('Cookie-only')
        )
      )
      state.files['config/session.ts'] =
        "export default { store: 'custom', stores: { custom: makeCustomStore() } }"
      const custom = await planSetup(choices, state)
      assert.isTrue(
        custom.diagnostics.some(
          ({ field, severity }) => field === 'config/session.ts' && severity === 'action'
        )
      )
    })
  })

  test('comments do not certify Shield and empty Limiter configuration fails', async ({
    assert,
  }) => {
    await withFixture(async (choices, state) => {
      state.files['config/shield.ts'] =
        '/* csrf: { enabled: true } */ export default { csrf: { enabled: process.env.CSRF === "on" } }'
      state.files['config/limiter.ts'] = 'export default defineConfig({})'
      const plan = await planSetup(choices, state)
      assert.isTrue(
        plan.diagnostics.some(
          ({ field, severity }) => field === 'config/shield.ts' && severity === 'action'
        )
      )
      assert.isTrue(
        plan.diagnostics.some(
          ({ field, severity }) => field === 'config/limiter.ts' && severity === 'error'
        )
      )
      state.files['config/limiter.ts'] =
        "export default defineConfig({ default: 'database', stores: { memory: stores.memory({}) } })"
      const wrongStore = await planSetup(choices, state)
      assert.isTrue(
        wrongStore.diagnostics.some(
          ({ field, severity }) => field === 'config/limiter.ts' && severity === 'error'
        )
      )
      state.files['config/limiter.ts'] =
        "export default defineConfig({ default: env.get('LIMITER_STORE'), stores: { memory: stores.memory({}) } })"
      const prior = process.env.LIMITER_STORE
      delete process.env.LIMITER_STORE
      try {
        const unresolved = await planSetup(choices, state)
        assert.isTrue(
          unresolved.diagnostics.some(
            ({ field, severity }) => field === 'config/limiter.ts' && severity === 'action'
          )
        )
      } finally {
        if (prior === undefined) delete process.env.LIMITER_STORE
        else process.env.LIMITER_STORE = prior
      }
    })
  })

  test('checks selected package minima and maintained destination rules', async ({ assert }) => {
    await withFixture(async (choices, state) => {
      state.installedVersions['@adonisjs/lucid'] = '22.0.0'
      state.installedVersions['@vinejs/vine'] = '4.0.0'
      state.installedVersions['@adonisjs/mail'] = '9.0.0'
      choices.mail.destinations.passwordReset = '%2e%2e/reset'
      choices.mail.destinations.emailVerification = ' account/verify '
      const plan = await planSetup(choices, state)
      const fields = plan.diagnostics.map(({ field }) => field)
      assert.include(fields, 'dependencies.@adonisjs/lucid')
      assert.include(fields, 'dependencies.@vinejs/vine')
      assert.notInclude(fields, 'dependencies.@adonisjs/mail')
      assert.include(fields, 'mail.destinations.passwordReset')
      assert.include(fields, 'mail.destinations.emailVerification')
    })
  })

  test('session CSRF guidance uses selected path or application-owned bootstrap', async ({
    assert,
  }) => {
    await withFixture(async (choices, state) => {
      const standard = await planSetup(choices, state)
      assert.isTrue(standard.prerequisites.some((item) => item.includes('GET /account/auth/csrf')))
      choices.managedExcept = ['auth.csrf']
      const excluded = await planSetup(choices, state)
      assert.isTrue(
        excluded.prerequisites.some((item) => item.includes('application-owned CSRF bootstrap'))
      )
      assert.isFalse(excluded.prerequisites.some((item) => item.includes('GET /account/auth/csrf')))
    })
  })

  test('commented middleware is not treated as installed', async ({ assert }) => {
    await withFixture(async (choices, state) => {
      state.files['start/kernel.ts'] =
        "server.use([() => import('@adonisjs/cors/cors_middleware')])\nrouter.use([\n  // () => import('@adonisjs/session/session_middleware'),\n  // () => import('@adonisjs/shield/shield_middleware'),\n  // () => import('@adonisjs/auth/initialize_auth_middleware'),\n  () => import('@adonisjs/core/bodyparser_middleware'),\n])"
      const plan = await planSetup(choices, state)
      const kernel = plan.changes.find(({ path }) => path === 'start/kernel.ts')
      assert.equal(kernel?.action, 'update')
      const executable = stripSourceComments(kernel!.content)
      for (const name of [
        '@adonisjs/session/session_middleware',
        '@adonisjs/shield/shield_middleware',
        '@adonisjs/auth/initialize_auth_middleware',
      ])
        assert.equal(executable.split(name).length - 1, 1)
    })
  })

  test('model metadata ignores comments and rejects every explicit connection', async ({
    assert,
  }) => {
    await withFixture(async (choices, state, root) => {
      await writeFile(
        join(root, 'app/models/user.ts'),
        "export default class User extends BaseModel {\n // static table = 'users'\n static table = 'members'\n // static connection = 'other'\n static connection = 'default'\n }"
      )
      const plan = await planSetup(choices, state)
      assert.include(
        plan.diagnostics.map(({ field }) => field),
        'user.table'
      )
      assert.isTrue(
        plan.diagnostics.some(
          ({ field, severity, message }) =>
            field === 'user.connection' &&
            severity === 'error' &&
            message.includes('explicit connection')
        )
      )
    })
  })

  test('runtime feature dependency does not depend on verification policy', async ({ assert }) => {
    await withFixture(async (choices, state) => {
      choices.features = ['authentication', 'emailPasswordManagement']
      choices.managed = ['authentication', 'emailPasswordManagement']
      choices.policy.registration = 'closed'
      choices.policy.verificationRequired = false
      const plan = await planSetup(choices, state)
      assert.include(
        plan.diagnostics.map(({ field }) => field),
        'features'
      )
    })
  })

  test('maintained Mail validates brand and sender without leaking values', async ({ assert }) => {
    await withFixture(async (choices, state) => {
      choices.mail.integration = 'adonisjs-mail'
      choices.mail.appName = 'Brand\r\nInjected'
      state.files['config/mail.ts'] = 'export default defineConfig({ mailers: {} })'
      const prior = process.env.ACCOUNT_MAIL_FROM
      process.env.ACCOUNT_MAIL_FROM = 'person@example.test\nInjected'
      try {
        const plan = await planSetup(choices, state)
        assert.include(
          plan.diagnostics.map(({ field }) => field),
          'mail.appName'
        )
        assert.include(
          plan.diagnostics.map(({ field }) => field),
          'mail.senderEnv'
        )
        assert.isFalse(JSON.stringify(plan.diagnostics).includes('person@example.test'))
        process.env.ACCOUNT_MAIL_FROM = '   '
        const blank = await planSetup(choices, state)
        assert.isTrue(
          blank.diagnostics.some(
            ({ field, severity }) => field === 'mail.senderEnv' && severity === 'error'
          )
        )
      } finally {
        if (prior === undefined) delete process.env.ACCOUNT_MAIL_FROM
        else process.env.ACCOUNT_MAIL_FROM = prior
      }
    })
  })

  test('production memory sessions conflict with persistence claims', async ({ assert }) => {
    await withFixture(async (choices, state) => {
      state.files['config/session.ts'] =
        "export default { store: 'memory', stores: { memory: stores.memory() } }"
      choices.authentication!.session!.persistentStore = true
      const plan = await planSetup(choices, state, { production: true })
      assert.isTrue(
        plan.diagnostics.some(
          ({ field, severity, message }) =>
            field === 'config/session.ts' &&
            severity === 'error' &&
            message.includes('persistent shared')
        )
      )
    })
  })

  test('callback files alone do not certify external configuration', async ({ assert }) => {
    await withFixture(async (choices, state) => {
      const plan = await planSetup(choices, state)
      assert.include(
        plan.diagnostics.map(({ field }) => field),
        'policy.callbacks'
      )
      assert.include(
        plan.diagnostics.map(({ field }) => field),
        'mail.callbacks'
      )
      assert.isFalse(plan.readiness.externalConfigured)
    })
  })

  test('excluded managed signup permits application admission and rejects prototype field names', async ({
    assert,
  }) => {
    await withFixture(async (choices, state) => {
      choices.policy.registration = 'application'
      choices.managedExcept = ['auth.signup']
      choices.policy.registrationFields = [{ name: '__proto__', type: 'string', required: false }]
      const plan = await planSetup(choices, state)
      assert.isFalse(plan.diagnostics.some(({ field }) => field === 'policy.registration'))
      assert.include(
        plan.diagnostics.map(({ field }) => field),
        'policy.registrationFields.0.name'
      )
    })
  })

  test('managed session wrapper is replayable, reversible, and protects owner edits', async ({
    assert,
  }) => {
    await withFixture(async (choices, state) => {
      const original =
        "import env from '#start/env'\nimport { defineConfig, stores } from '@adonisjs/session'\nconst sessionConfig = defineConfig({ store: env.get('SESSION_DRIVER'), stores: { database: stores.database() } })\nexport default sessionConfig\n"
      state.files['config/session.ts'] = original
      const initial = await planSetup(choices, state)
      const session = initial.changes.find(({ path }) => path === 'config/session.ts')!
      assert.equal(session.action, 'update')
      assert.include(session.content, 'protectManagedSessionConfig')
      assert.include(session.content, 'accountKitSelectedSessionStore === "database"')
      state.files['config/session.ts'] = session.content
      state.existingChoices = structuredClone(choices)
      const repeated = await planSetup(choices, state)
      assert.equal(
        repeated.changes.find(({ path }) => path === 'config/session.ts')?.action,
        'unchanged'
      )
      const oldDriver = process.env.SESSION_DRIVER
      process.env.SESSION_DRIVER = 'database'
      try {
        const selected = await planSetup(choices, state)
        assert.isFalse(selected.diagnostics.some(({ field }) => field === 'config/session.ts'))
      } finally {
        if (oldDriver === undefined) delete process.env.SESSION_DRIVER
        else process.env.SESSION_DRIVER = oldDriver
      }
      const disabled = structuredClone(choices)
      disabled.managed = []
      const retirement = await planSetup(disabled, state)
      const unwrapped = retirement.changes.find(({ path }) => path === 'config/session.ts')!
      assert.equal(unwrapped.action, 'update')
      assert.equal(unwrapped.content, original)
      state.files['config/session.ts'] = unwrapped.content
      state.existingChoices = disabled
      const reenabled = await planSetup(choices, state)
      assert.equal(
        reenabled.changes.find(({ path }) => path === 'config/session.ts')?.content,
        session.content
      )
      state.files['config/session.ts'] = session.content.replace("'destroy'", "'destroyOther'")
      const ownerEdit = await planSetup(choices, state)
      assert.isTrue(ownerEdit.diagnostics.some(({ field }) => field === 'config/session.ts'))
    })
  })

  test('unsupported session config requires manual protection before apply', async ({ assert }) => {
    await withFixture(async (choices, state) => {
      state.files['config/session.ts'] =
        'export default defineConfig({ store: pickSessionStore(), stores: { custom: makeStore() } })'
      const plan = await planSetup(choices, state)
      assert.isTrue(
        plan.diagnostics.some(
          ({ field, severity, message }) =>
            field === 'config/session.ts' &&
            severity === 'error' &&
            message.includes('protectManagedSessionConfig')
        )
      )
      state.files['config/session.ts'] =
        "const sessionConfig = defineConfig({ store: 'custom', unrelated: { custom: stores.database() }, stores: { custom: makeStore() } })\nexport default sessionConfig\n"
      const unrelated = await planSetup(choices, state)
      assert.isTrue(
        unrelated.diagnostics.some(
          ({ field, severity, message }) =>
            field === 'config/session.ts' &&
            severity === 'error' &&
            message.includes('protectManagedSessionConfig')
        )
      )
    })
  })
})
