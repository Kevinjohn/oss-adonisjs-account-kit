import { mkdtemp, mkdir, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from '@japa/runner'
import ts from 'typescript'
import { defaultSetupChoices } from '../src/setup/defaults.js'
import { planSetup } from '../src/setup/plan.js'
import { applySetup } from '../src/setup/apply.js'
import { stripSourceComments } from '../src/setup/source_text.js'
import type { SetupChoices, SetupInspection } from '../src/setup/types.js'

const versions: Record<string, string> = {
  'typescript': '5.9.3',
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
    "import { BaseModel, column } from '@adonisjs/lucid/orm'\nexport default class User extends BaseModel { @column({ isPrimary: true }) declare id: number }"
  )
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({ imports: { '#models/*': './app/models/*.js' } })
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
        "import router from '@adonisjs/core/services/router'\nimport server from '@adonisjs/core/services/server'\nserver.use([() => import('@adonisjs/cors/cors_middleware')])\nrouter.use([() => import('@adonisjs/core/bodyparser_middleware')])",
      'config/shield.ts': 'export default { csrf: { enabled: true } }',
      'config/session.ts':
        "export default { store: 'database', stores: { database: stores.database() } }",
      'config/limiter.ts':
        "import { defineConfig, stores } from '@adonisjs/limiter'\nexport default defineConfig({ default: 'memory', stores: { memory: stores.memory({}) } })",
      'app/services/account_kit_policy.ts': 'export const accountKitPolicy = {}',
      'app/services/account_kit_notifications.ts': 'export const accountKitNotifications = {}',
    },
    guards: ['web'],
    guardStrategies: { web: 'session' },
    guardModels: { web: '#models/user' },
    guardTokenProviders: {},
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
  test('setup requires an explicitly installed supported TypeScript parser', async ({ assert }) => {
    await withFixture(async (choices, state) => {
      delete state.installedVersions.typescript
      state.installedPackages = state.installedPackages.filter((name) => name !== 'typescript')
      const missing = await planSetup(choices, state)
      assert.isTrue(
        missing.diagnostics.some(
          ({ field, severity }) => field === 'dependencies.typescript' && severity === 'error'
        )
      )
      state.installedPackages.push('typescript')
      state.installedVersions.typescript = '5.8.0'
      const old = await planSetup(choices, state)
      assert.isTrue(
        old.diagnostics.some(
          ({ field, severity }) => field === 'dependencies.typescript' && severity === 'error'
        )
      )
      state.installedVersions.typescript = '6.0.3'
      const supported = await planSetup(choices, state)
      assert.isFalse(
        supported.diagnostics.some(
          ({ field, severity }) => field === 'dependencies.typescript' && severity === 'error'
        )
      )
    })
  })
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
  }).timeout(10_000)

  test('optional registration fields ignore inherited object properties', async ({ assert }) => {
    await withFixture(async (choices, state) => {
      choices.policy.registrationFields = [{ name: 'toString', type: 'string', required: false }]
      const plan = await planSetup(choices, state)
      assert.isFalse(
        plan.diagnostics.some(({ field }) => field === 'policy.registrationFields.0.name')
      )
      const config = plan.changes.find(({ path }) => path === 'config/account_kit.ts')!.content
      const mapper = config.slice(
        config.indexOf('const registrationFields:'),
        config.indexOf('const users =')
      )
      const runnable = ts.transpileModule(
        `class InvalidInputError extends Error {}\n${mapper}\nreturn mapRegistrationFields`,
        { compilerOptions: { target: ts.ScriptTarget.ES2022 } }
      ).outputText
      const map = new Function(runnable)() as (input: unknown) => Record<string, unknown>
      assert.deepEqual(map({}), {})
      assert.deepEqual(map({ toString: 'Only an own field' }), {
        toString: 'Only an own field',
      })
      assert.include(config, 'Object.prototype.hasOwnProperty.call(fields, field.name)')
    })
  })

  test('authentication-only service setup leaves email delivery not applicable', async ({
    assert,
  }) => {
    await withFixture(async (choices, state) => {
      choices.mode = 'services'
      choices.features = ['authentication']
      choices.managed = []
      choices.policy.registration = 'closed'
      choices.policy.verificationRequired = false
      choices.authentication!.applicationRouteRevocation = true
      delete state.files['config/mail.ts']
      delete state.files['app/services/account_kit_notifications.ts']
      state.installedPackages = state.installedPackages.filter((name) => name !== '@adonisjs/mail')
      delete state.installedVersions['@adonisjs/mail']
      const plan = await planSetup(choices, state)
      const config = plan.changes.find(({ path }) => path === 'config/account_kit.ts')!.content
      assert.equal(plan.pillars.mail, 'not applicable: no email capability selected')
      assert.equal(plan.readiness.delivery, 'not applicable')
      assert.notInclude(config, 'createActionUrls')
      assert.notInclude(config, 'accountKitNotifications')
      assert.notInclude(config, 'createMailNotifications')
      assert.include(config, '  urls: {},')
      assert.include(config, '  notify: {},')
      assert.isFalse(
        plan.diagnostics.some(
          ({ field }) =>
            field.startsWith('mail.') ||
            field === 'config/mail.ts' ||
            field === 'dependencies.@adonisjs/mail'
        )
      )
      assert.notInclude(
        plan.changes.find(({ path }) => path === 'adonisrc.ts')?.content ?? '',
        '@adonisjs/mail/mail_provider'
      )
      assert.notInclude(
        plan.changes.find(({ path }) => path === '.env.account-kit.example')!.content,
        choices.mail.frontendOriginEnv
      )
    })
  })

  test('middleware insertion places comma before an inline comment', async ({ assert }) => {
    await withFixture(async (choices, state) => {
      state.files['start/kernel.ts'] =
        "import router from '@adonisjs/core/services/router'\nimport server from '@adonisjs/core/services/server'\nserver.use([() => import('@adonisjs/cors/cors_middleware')])\nrouter.use([\n  () => import('@adonisjs/core/bodyparser_middleware') // parse requests\n])"
      const plan = await planSetup(choices, state)
      const content = plan.changes.find(({ path }) => path === 'start/kernel.ts')!.content
      assert.include(
        content,
        "() => import('@adonisjs/core/bodyparser_middleware'), // parse requests"
      )
      const parsed = ts.createSourceFile(
        'kernel.ts',
        content,
        ts.ScriptTarget.ES2022
      ) as ts.SourceFile & {
        parseDiagnostics: readonly ts.Diagnostic[]
      }
      assert.isEmpty(parsed.parseDiagnostics)
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
          ({ field, severity }) => field === 'config/session.ts' && severity === 'error'
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
        "import { defineConfig, stores } from '@adonisjs/limiter'\nexport default defineConfig({ default: 'database', stores: { memory: stores.memory({}) } })"
      const wrongStore = await planSetup(choices, state)
      assert.isTrue(
        wrongStore.diagnostics.some(
          ({ field, severity }) => field === 'config/limiter.ts' && severity === 'error'
        )
      )
      state.files['config/limiter.ts'] =
        "import { defineConfig, stores } from '@adonisjs/limiter'\nconst example = `default: 'memory', stores: { memory: stores.memory({}) }`\nexport default defineConfig({})"
      const quoted = await planSetup(choices, state)
      assert.isTrue(
        quoted.diagnostics.some(
          ({ field, severity }) => field === 'config/limiter.ts' && severity === 'error'
        )
      )
      state.files['config/limiter.ts'] =
        "import env from '#start/env'\nimport { defineConfig, stores } from '@adonisjs/limiter'\nexport default defineConfig({ default: env.get('LIMITER_STORE'), stores: { memory: stores.memory({}) } })"
      const prior = process.env.LIMITER_STORE
      delete process.env.LIMITER_STORE
      try {
        const unresolved = await planSetup(choices, state)
        assert.isTrue(
          unresolved.diagnostics.some(
            ({ field, severity }) => field === 'config/limiter.ts' && severity === 'error'
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
      const inert = await planSetup(choices, state)
      assert.isTrue(
        inert.prerequisites.some((item) => item.includes('application-owned CSRF bootstrap'))
      )
      assert.isFalse(inert.prerequisites.some((item) => item.includes('GET /account/auth/csrf')))

      choices.authentication!.applicationRouteRevocation = true
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
        "import router from '@adonisjs/core/services/router'\nimport server from '@adonisjs/core/services/server'\nserver.use([() => import('@adonisjs/cors/cors_middleware')])\nrouter.use([\n  // () => import('@adonisjs/session/session_middleware'),\n  // () => import('@adonisjs/shield/shield_middleware'),\n  // () => import('@adonisjs/auth/initialize_auth_middleware'),\n  () => import('@adonisjs/core/bodyparser_middleware'),\n])"
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
      const oldDriver = process.env.SESSION_DRIVER
      process.env.SESSION_DRIVER = 'database'
      try {
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
        const selected = await planSetup(choices, state)
        assert.isFalse(selected.diagnostics.some(({ field }) => field === 'config/session.ts'))
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
      } finally {
        if (oldDriver === undefined) delete process.env.SESSION_DRIVER
        else process.env.SESSION_DRIVER = oldDriver
      }
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

  test('session attestation requires the native binding and direct stores map', async ({
    assert,
  }) => {
    await withFixture(async (choices, state) => {
      const config = (binding: string, body: string) =>
        `${binding}\nconst sessionConfig = defineConfig({ store: 'database', ${body} })\nexport default sessionConfig\n`
      const customBinding = config(
        "import { defineConfig, stores } from './custom_session.js'",
        'stores: { database: stores.database() }'
      )
      const nestedOnly = config(
        "import { defineConfig, stores } from '@adonisjs/session'",
        'unrelated: { stores: { database: stores.database() } }'
      )
      const typeOnly = config(
        "import type { defineConfig, stores } from '@adonisjs/session'",
        'stores: { database: stores.database() }'
      )
      for (const source of [customBinding, nestedOnly, typeOnly]) {
        state.files['config/session.ts'] = source
        const plan = await planSetup(choices, state)
        assert.isTrue(
          plan.diagnostics.some(
            ({ field, severity }) => field === 'config/session.ts' && severity === 'error'
          )
        )
        assert.isUndefined(plan.changes.find(({ path }) => path === 'config/session.ts'))
      }
    })
  })

  test('an unused native sibling cannot attest a selected custom store', async ({ assert }) => {
    await withFixture(async (choices, state) => {
      state.files['config/session.ts'] =
        "import { defineConfig, stores } from '@adonisjs/session'\nconst sessionConfig = defineConfig({ store: 'custom', stores: { database: stores.database(), custom: customStore() } })\nexport default sessionConfig\n"
      const plan = await planSetup(choices, state)
      assert.isTrue(
        plan.diagnostics.some(
          ({ field, severity, message }) =>
            field === 'config/session.ts' &&
            severity === 'error' &&
            message.includes('selected session factory')
        )
      )
      assert.isUndefined(plan.changes.find(({ path }) => path === 'config/session.ts'))
      const prior = process.env.SESSION_DRIVER
      process.env.SESSION_DRIVER = 'custom'
      try {
        state.files['config/session.ts'] = state.files['config/session.ts'].replace(
          "store: 'custom'",
          "store: env.get('SESSION_DRIVER')"
        )
        const selectedFromEnvironment = await planSetup(choices, state)
        assert.isTrue(
          selectedFromEnvironment.diagnostics.some(
            ({ field, severity }) => field === 'config/session.ts' && severity === 'error'
          )
        )
      } finally {
        if (prior === undefined) delete process.env.SESSION_DRIVER
        else process.env.SESSION_DRIVER = prior
      }
    })
  })

  test('a later store override cannot borrow an earlier native attestation', async ({ assert }) => {
    await withFixture(async (choices, state) => {
      for (const stores of [
        'database: stores.database(), database: customStore()',
        String.raw`database: stores.database(), '\u0064atabase': customStore()`,
        'database: stores.database(), ...customStores',
      ]) {
        state.files['config/session.ts'] =
          `import { defineConfig, stores } from '@adonisjs/session'\nconst sessionConfig = defineConfig({ store: 'database', stores: { ${stores} } })\nexport default sessionConfig\n`
        const plan = await planSetup(choices, state)
        assert.isTrue(
          plan.diagnostics.some(
            ({ field, severity }) => field === 'config/session.ts' && severity === 'error'
          )
        )
        assert.isUndefined(plan.changes.find(({ path }) => path === 'config/session.ts'))
      }
    })
  })

  test('escaped Shield keys cannot override inspected CSRF state', async ({ assert }) => {
    await withFixture(async (choices, state) => {
      state.files['config/shield.ts'] =
        String.raw`export default { csrf: { enabled: true, '\u0065nabled': false } }`
      const plan = await planSetup(choices, state)
      assert.isTrue(
        plan.diagnostics.some(
          ({ field, severity }) => field === 'config/shield.ts' && severity === 'error'
        )
      )
    })
  })

  test('selected session environment follows Adonis precedence without exposing other values', async ({
    assert,
  }) => {
    await withFixture(async (choices, state, root) => {
      const prior = {
        selected: process.env.SESSION_DRIVER,
        mode: process.env.NODE_ENV,
        path: process.env.ENV_PATH,
      }
      try {
        delete process.env.SESSION_DRIVER
        delete process.env.ENV_PATH
        process.env.NODE_ENV = 'development'
        state.files['config/session.ts'] =
          "import env from '#start/env'\nimport { defineConfig, stores } from '@adonisjs/session'\nconst sessionConfig = defineConfig({ store: env.get('SESSION_DRIVER'), stores: { database: stores.database(), memory: stores.memory() } })\nexport default sessionConfig\n"
        await writeFile(join(root, '.env'), 'SESSION_DRIVER=memory\nPRIVATE_VALUE=hidden-value\n')
        await writeFile(join(root, '.env.development'), 'SESSION_DRIVER=database\n')
        const fromFile = await planSetup(choices, state)
        assert.isFalse(
          fromFile.diagnostics.some(
            ({ field, severity }) => field === 'config/session.ts' && severity === 'error'
          )
        )
        assert.isFalse(JSON.stringify(fromFile).includes('hidden-value'))
        await writeFile(join(root, '.env.development.local'), 'SESSION_DRIVER="memory"\n')
        const local = await planSetup(choices, state)
        assert.isFalse(
          local.diagnostics.some(
            ({ field, severity }) => field === 'config/session.ts' && severity === 'error'
          )
        )
        process.env.SESSION_DRIVER = 'database'
        const override = await planSetup(choices, state)
        assert.isFalse(
          override.diagnostics.some(
            ({ field, severity }) => field === 'config/session.ts' && severity === 'error'
          )
        )
        process.env.SESSION_DRIVER = 'custom'
        const rejected = await planSetup(choices, state)
        assert.isTrue(
          rejected.diagnostics.some(
            ({ field, severity }) => field === 'config/session.ts' && severity === 'error'
          )
        )
      } finally {
        for (const [name, value] of [
          ['SESSION_DRIVER', prior.selected],
          ['NODE_ENV', prior.mode],
          ['ENV_PATH', prior.path],
        ] as const) {
          if (value === undefined) delete process.env[name]
          else process.env[name] = value
        }
      }
    })
  })

  test('session selector rejects ambiguous, unresolved, and linked environment files', async ({
    assert,
  }) => {
    await withFixture(async (choices, state, root) => {
      const prior = process.env.SESSION_DRIVER
      try {
        delete process.env.SESSION_DRIVER
        state.files['config/session.ts'] =
          "import env from '#start/env'\nimport { defineConfig, stores } from '@adonisjs/session'\nconst sessionConfig = defineConfig({ store: env.get('SESSION_DRIVER'), stores: { database: stores.database() } })\nexport default sessionConfig\n"
        const missing = await planSetup(choices, state)
        assert.isTrue(
          missing.diagnostics.some(
            ({ field, severity }) => field === 'config/session.ts' && severity === 'error'
          )
        )
        for (const assignment of [
          'SESSION_DRIVER=$OTHER\n',
          'SESSION_DRIVER=database\nSESSION_DRIVER=custom\n',
          'SESSION_DRIVER="database\n',
          'PRIVATE_TEXT="first line\nSESSION_DRIVER=database\nlast line"\n',
        ]) {
          await writeFile(join(root, '.env'), assignment)
          const rejected = await planSetup(choices, state)
          assert.isTrue(
            rejected.diagnostics.some(
              ({ field, severity }) => field === 'config/session.ts' && severity === 'error'
            )
          )
          assert.isUndefined(rejected.changes.find(({ path }) => path === 'config/session.ts'))
        }
        await rm(join(root, '.env'))
        await symlink('/tmp/unsupported-session-env', join(root, '.env'))
        const linked = await planSetup(choices, state)
        assert.isTrue(
          linked.diagnostics.some(
            ({ field, severity }) => field === 'config/session.ts' && severity === 'error'
          )
        )
        assert.isFalse(JSON.stringify(linked).includes('/tmp/unsupported-session-env'))
      } finally {
        if (prior === undefined) delete process.env.SESSION_DRIVER
        else process.env.SESSION_DRIVER = prior
      }
    })
  })

  test('session selector reads only the variable named by the configured expression', async ({
    assert,
  }) => {
    await withFixture(async (choices, state, root) => {
      const prior = process.env.SESSION_DRIVER
      try {
        process.env.SESSION_DRIVER = 'database'
        state.files['config/session.ts'] =
          "import env from '#start/env'\nimport { defineConfig, stores } from '@adonisjs/session'\nconst sessionConfig = defineConfig({ store: env.get('APP_SESSION_STORE'), stores: { database: stores.database() } })\nexport default sessionConfig\n"
        const missing = await planSetup(choices, state)
        assert.isTrue(
          missing.diagnostics.some(
            ({ field, severity }) => field === 'config/session.ts' && severity === 'error'
          )
        )
        await writeFile(join(root, '.env'), 'APP_SESSION_STORE=database\n')
        const selected = await planSetup(choices, state)
        assert.isFalse(
          selected.diagnostics.some(
            ({ field, severity }) => field === 'config/session.ts' && severity === 'error'
          )
        )
      } finally {
        if (prior === undefined) delete process.env.SESSION_DRIVER
        else process.env.SESSION_DRIVER = prior
      }
    })
  })

  test('native session attestation requires complete selected factory expressions', async ({
    assert,
  }) => {
    await withFixture(async (choices, state) => {
      for (const config of [
        "{ store: 'database' + suffix, stores: { database: stores.database() } }",
        "{ store: 'database', stores: { database: stores.database() && customFactory } }",
        "{ store: 'database', stores: { database: stores.database() }, ...override }",
      ]) {
        state.files['config/session.ts'] =
          `import { defineConfig, stores } from '@adonisjs/session'\nconst sessionConfig = defineConfig(${config})\nexport default sessionConfig\n`
        const plan = await planSetup(choices, state)
        assert.isTrue(
          plan.diagnostics.some(
            ({ field, severity }) => field === 'config/session.ts' && severity === 'error'
          )
        )
        assert.isUndefined(plan.changes.find(({ path }) => path === 'config/session.ts'))
      }
      state.files['config/session.ts'] =
        "import { defineConfig, stores } from '@adonisjs/session'\nconst sessionConfig = defineConfig({ store: 'database', stores: { database: stores.database() } })\nObject.assign(sessionConfig, { store: 'custom' })\nexport default sessionConfig\n"
      const mutated = await planSetup(choices, state)
      assert.isTrue(
        mutated.diagnostics.some(
          ({ field, severity }) => field === 'config/session.ts' && severity === 'error'
        )
      )
    })
  })

  test('quoted wrapper examples cannot bypass actual managed session wiring', async ({
    assert,
  }) => {
    await withFixture(async (choices, state) => {
      state.files['config/session.ts'] =
        "import { defineConfig, stores } from '@adonisjs/session'\nconst example = `protectManagedSessionConfig(sessionConfig, {})`\nconst sessionConfig = defineConfig({ store: 'database', stores: { database: stores.database() } })\nexport default sessionConfig\n"
      const plan = await planSetup(choices, state)
      const session = plan.changes.find(({ path }) => path === 'config/session.ts')
      assert.equal(session?.action, 'update')
      assert.include(session?.content ?? '', 'export default protectManagedSessionConfig(')
      assert.isFalse(
        plan.diagnostics.some(
          ({ field, severity }) => field === 'config/session.ts' && severity === 'error'
        )
      )
    })
  })

  test('literal examples cannot register providers, routes, middleware, or Shield', async ({
    assert,
  }) => {
    await withFixture(async (choices, state) => {
      state.files['adonisrc.ts'] =
        "const example = `providers: [() => import('@adonisjs/auth/auth_provider')]`\nexport default { providers: [] }\n"
      state.files['start/routes.ts'] = "const example = `import './account_kit_routes.js'`\n"
      state.files['start/kernel.ts'] =
        "import router from '@adonisjs/core/services/router'\nimport server from '@adonisjs/core/services/server'\nconst example = `() => import('@adonisjs/shield/shield_middleware'); () => import('#middleware/account_kit_proof_headers_middleware')`\nserver.use([])\nrouter.use([() => import('@adonisjs/core/bodyparser_middleware')])\n"
      state.files['config/shield.ts'] =
        "const example = `csrf: { enabled: true }`\nexport default { csrf: { enabled: process.env.CSRF === 'on' } }\n"
      const plan = await planSetup(choices, state)
      const providers = plan.changes.find(({ path }) => path === 'adonisrc.ts')?.content ?? ''
      const routes = plan.changes.find(({ path }) => path === 'start/routes.ts')?.content ?? ''
      const kernel = plan.changes.find(({ path }) => path === 'start/kernel.ts')?.content ?? ''
      assert.equal(providers.split("import('@adonisjs/auth/auth_provider')").length - 1, 2)
      assert.equal(kernel.split("import('@adonisjs/shield/shield_middleware')").length - 1, 2)
      assert.equal(
        kernel.split("import('#middleware/account_kit_proof_headers_middleware')").length - 1,
        2
      )
      const routeSource = ts.createSourceFile('routes.ts', routes, ts.ScriptTarget.Latest)
      assert.isTrue(
        routeSource.statements.some(
          (node) =>
            ts.isImportDeclaration(node) &&
            ts.isStringLiteral(node.moduleSpecifier) &&
            node.moduleSpecifier.text === './account_kit_routes.js'
        )
      )
      assert.isTrue(
        plan.diagnostics.some(
          ({ field, severity }) => field === 'config/shield.ts' && severity === 'action'
        )
      )
      for (const path of ['adonisrc.ts', 'start/routes.ts', 'start/kernel.ts']) {
        const content = plan.changes.find((change) => change.path === path)?.content
        if (!content) continue
        const parsed = ts.createSourceFile(
          path,
          content,
          ts.ScriptTarget.Latest
        ) as ts.SourceFile & {
          parseDiagnostics: readonly ts.Diagnostic[]
        }
        assert.isEmpty(parsed.parseDiagnostics)
      }
    })
  })

  test('multiline body parser is edited after its complete expression', async ({ assert }) => {
    await withFixture(async (choices, state) => {
      state.files['start/kernel.ts'] =
        "import router from '@adonisjs/core/services/router'\nimport server from '@adonisjs/core/services/server'\nserver.use([])\nrouter.use([\n  () => import(\n    '@adonisjs/core/bodyparser_middleware'\n  ) // parse body\n])\n"
      const plan = await planSetup(choices, state)
      const content = plan.changes.find(({ path }) => path === 'start/kernel.ts')!.content
      assert.include(content, '  ), // parse body')
      assert.include(content, "() => import('@adonisjs/session/session_middleware')")
      const parsed = ts.createSourceFile(
        'kernel.ts',
        content,
        ts.ScriptTarget.Latest
      ) as ts.SourceFile & {
        parseDiagnostics: readonly ts.Diagnostic[]
      }
      assert.isEmpty(parsed.parseDiagnostics)
    })
  })

  test('quoted model metadata cannot hide actual table or token provider', async ({ assert }) => {
    await withFixture(async (choices, state, root) => {
      await writeFile(
        join(root, 'app/models/user.ts'),
        "const example = `static table = 'users'; static accessTokens = tokens`\nexport default class User extends BaseModel { static table = 'members' }\n"
      )
      const wrongTable = await planSetup(choices, state)
      assert.isTrue(
        wrongTable.diagnostics.some(
          ({ field, severity }) => field === 'user.table' && severity === 'error'
        )
      )
      choices.authentication!.strategy = 'access_tokens'
      const missingTokens = await planSetup(choices, state)
      assert.isTrue(
        missingTokens.diagnostics.some(
          ({ field, severity }) => field === 'user.model' && severity === 'error'
        )
      )
    })
  })

  test('dotenv-selected memory store is rejected in production', async ({ assert }) => {
    await withFixture(async (choices, state, root) => {
      const prior = process.env.APP_SESSION_STORE
      try {
        delete process.env.APP_SESSION_STORE
        await writeFile(join(root, '.env'), 'APP_SESSION_STORE=memory\n')
        state.files['config/session.ts'] =
          "import env from '#start/env'\nimport { defineConfig, stores } from '@adonisjs/session'\nconst sessionConfig = defineConfig({ store: env.get('APP_SESSION_STORE'), stores: { database: stores.database(), memory: stores.memory() } })\nexport default sessionConfig\n"
        const plan = await planSetup(choices, state, { production: true })
        assert.isTrue(
          plan.diagnostics.some(
            ({ field, severity, message }) =>
              field === 'config/session.ts' &&
              severity === 'error' &&
              message.includes('persistent shared')
          )
        )
      } finally {
        if (prior === undefined) delete process.env.APP_SESSION_STORE
        else process.env.APP_SESSION_STORE = prior
      }
    })
  })

  test('ambiguous config objects and later bindings cannot certify integrations', async ({
    assert,
  }) => {
    await withFixture(async (choices, state) => {
      state.files['adonisrc.ts'] =
        'const config = { providers: [] }; config.providers = []; export default config'
      state.files['config/shield.ts'] =
        "export default { csrf: { enabled: true, ['enabled']: false } }"
      state.files['config/limiter.ts'] =
        "import { defineConfig, stores } from '@adonisjs/limiter'\nexport default defineConfig({ default: 'memory', stores: { memory: stores.doesNotExist({}) } })"
      const plan = await planSetup(choices, state)
      assert.isTrue(
        plan.diagnostics.some(
          ({ field, severity }) => field === 'adonisrc.ts' && severity === 'error'
        )
      )
      assert.isTrue(
        plan.diagnostics.some(
          ({ field, severity }) => field === 'config/shield.ts' && severity === 'error'
        )
      )
      assert.isTrue(
        plan.diagnostics.some(
          ({ field, severity }) => field === 'config/limiter.ts' && severity === 'error'
        )
      )
    })
  })

  test('existing proof middleware must lead server middleware', async ({ assert }) => {
    await withFixture(async (choices, state) => {
      state.files['start/kernel.ts'] =
        "import router from '@adonisjs/core/services/router'\nimport server from '@adonisjs/core/services/server'\nserver.use([() => import('@adonisjs/core/bodyparser_middleware'), () => import('#middleware/account_kit_proof_headers_middleware')])\nrouter.use([])"
      const plan = await planSetup(choices, state)
      assert.isTrue(
        plan.diagnostics.some(
          ({ field, severity }) => field === 'start/kernel.ts' && severity === 'error'
        )
      )
    })
  })

  test('multiline selected session wrapper survives replay and removal', async ({ assert }) => {
    await withFixture(async (choices, state, root) => {
      state.files['config/session.ts'] =
        "import env from '#start/env'\nimport { defineConfig, stores } from '@adonisjs/session'\nconst sessionConfig = defineConfig({ store: env.get(\n  'SESSION_DRIVER',\n  'database'\n), stores: { database: stores.database() } })\nexport default sessionConfig\n"
      const first = await planSetup(choices, state)
      const wrapped = first.changes.find(({ path }) => path === 'config/session.ts')!.content
      state.files['config/session.ts'] = wrapped
      const replay = await planSetup(choices, state)
      assert.isFalse(
        replay.diagnostics.some(
          ({ field, severity }) => field === 'config/session.ts' && severity === 'error'
        )
      )
      choices.managed = []
      const removed = await planSetup(choices, state)
      assert.isFalse(
        removed.diagnostics.some(
          ({ field, severity }) => field === 'config/session.ts' && severity === 'error'
        )
      )
      assert.include(
        removed.changes.find(({ path }) => path === 'config/session.ts')!.content,
        "env.get(\n  'SESSION_DRIVER'"
      )
      void root
    })
  })

  test('registration requires verification service even with application-owned endpoints', async ({
    assert,
  }) => {
    await withFixture(async (choices, state) => {
      choices.features = ['registration']
      choices.managed = []
      const plan = await planSetup(choices, state)
      assert.isTrue(
        plan.diagnostics.some(
          ({ field, severity, message }) =>
            field === 'features' &&
            severity === 'error' &&
            message.includes('Registration requires')
        )
      )
    })
  })

  test('computed or later-mutated model metadata cannot certify migrations', async ({ assert }) => {
    await withFixture(async (choices, state, root) => {
      const model = join(root, 'app/models/user.ts')
      for (const source of [
        "import { BaseModel } from '@adonisjs/lucid/orm'\nexport default class User extends BaseModel { static table = 'users'; static ['table'] = 'members' }",
        "import { BaseModel } from '@adonisjs/lucid/orm'\nexport default class User extends BaseModel { static ['connection'] = 'other' }",
        "import { BaseModel } from '@adonisjs/lucid/orm'\nexport default class User extends BaseModel { static table = 'users' }\nUser.table = 'members'",
        "import { BaseModel } from '@adonisjs/lucid/orm'\nexport default class User extends BaseModel { static table = 'users'; static { this.table = 'members' } }",
        "import { BaseModel } from '@adonisjs/lucid/orm'\nexport default class User extends BaseModel { static get connection() { return 'other' } }",
        String.raw`import { BaseModel } from '@adonisjs/lucid/orm'
export default class User extends BaseModel { static table = 'users'; static '\u0074able' = 'members' }`,
      ]) {
        await writeFile(model, source)
        const plan = await planSetup(choices, state)
        assert.isTrue(
          plan.diagnostics.some(
            ({ field, severity }) => field === 'user.model' && severity === 'error'
          )
        )
      }
      choices.authentication!.strategy = 'access_tokens'
      await writeFile(
        model,
        "import { BaseModel } from '@adonisjs/lucid/orm'\nexport default class User extends BaseModel { static accessTokens = tokens; static { this.accessTokens = otherTokens } }"
      )
      const mutatedTokens = await planSetup(choices, state)
      assert.isTrue(
        mutatedTokens.diagnostics.some(
          ({ field, severity }) => field === 'user.model' && severity === 'error'
        )
      )
      choices.authentication!.strategy = 'session'
      await writeFile(
        model,
        "export default class User extends BaseModel { static table = 'users' }"
      )
      const unresolved = await planSetup(choices, state)
      assert.isTrue(
        unresolved.diagnostics.some(
          ({ field, severity }) => field === 'user.connection' && severity === 'error'
        )
      )
      await writeFile(
        model,
        "import { BaseModel } from '@adonisjs/lucid/orm'\nimport { compose } from '@adonisjs/core/helpers'\nexport default class User extends compose(BaseModel, withTokens) { static table = 'users' }"
      )
      const composed = await planSetup(choices, state)
      assert.isTrue(
        composed.diagnostics.some(
          ({ field, severity }) => field === 'user.connection' && severity === 'error'
        )
      )
    })
  })

  test('route mount distinguishes type imports and aliased executable registration', async ({
    assert,
  }) => {
    await withFixture(async (choices, state) => {
      state.files['start/routes.ts'] = "import type {} from './account_kit_routes.js'\n"
      const typeOnly = await planSetup(choices, state)
      assert.include(
        typeOnly.changes.find(({ path }) => path === 'start/routes.ts')!.content,
        "import './account_kit_routes.js'"
      )
      state.files['start/routes.ts'] =
        "import { registerManagedRoutes as mount } from 'adonisjs-account-kit/http'\nmount(router, {})\n"
      const alias = await planSetup(choices, state)
      assert.isTrue(
        alias.diagnostics.some(
          ({ field, severity }) => field === 'start/routes.ts' && severity === 'error'
        )
      )
      assert.isFalse(alias.changes.some(({ path }) => path === 'start/routes.ts'))
      state.files['start/routes.ts'] =
        "import { registerManagedRoutes } from 'adonisjs-account-kit/http'\nconst mount = registerManagedRoutes\nmount(router, {})\n"
      const escaped = await planSetup(choices, state)
      assert.isTrue(
        escaped.diagnostics.some(
          ({ field, severity }) => field === 'start/routes.ts' && severity === 'error'
        )
      )
      assert.isFalse(escaped.changes.some(({ path }) => path === 'start/routes.ts'))
      state.files['start/routes.ts'] =
        "import type { registerManagedRoutes } from 'adonisjs-account-kit/http'\nconst example = 'registerManagedRoutes'\n"
      const typeOnlyName = await planSetup(choices, state)
      assert.isFalse(
        typeOnlyName.diagnostics.some(
          ({ field, severity }) => field === 'start/routes.ts' && severity === 'error'
        )
      )
      for (const routes of [
        "import * as account from 'adonisjs-account-kit/http'\nconst mount = account.registerManagedRoutes\nmount(router, {})\n",
        "import { registerManagedRoutes as first, registerManagedRoutes as second } from 'adonisjs-account-kit/http'\nsecond(router, {})\n",
        "import { registerManagedRoutes as mount } from 'adonisjs-account-kit/http'\nimport { createManagedGuard } from 'adonisjs-account-kit/http'\nmount(router, {})\n",
        "import { registerManagedRoutes as mount } from 'adonisjs-account-kit/http'\nconst other = await import('adonisjs-account-kit/http')\nmount(router, {})\n",
      ]) {
        state.files['start/routes.ts'] = routes
        const hidden = await planSetup(choices, state)
        assert.isTrue(
          hidden.diagnostics.some(
            ({ field, severity }) => field === 'start/routes.ts' && severity === 'error'
          )
        )
        assert.isFalse(hidden.changes.some(({ path }) => path === 'start/routes.ts'))
      }
    })
  })

  test('authentication retirement identifies application-owned access middleware cleanup', async ({
    assert,
  }) => {
    await withFixture(async (choices, state) => {
      state.existingChoices = structuredClone(choices)
      state.files['app/middleware/account_kit_access_middleware.ts'] =
        'export default class AccountAccess {}'
      choices.authentication = null
      choices.managed = []
      const plan = await planSetup(choices, state)
      assert.isTrue(
        plan.diagnostics.some(
          ({ field, severity, message }) =>
            field === 'authentication.retirement' &&
            severity === 'action' &&
            message.includes('application-owned routes')
        )
      )
    })
  })

  test('mutated Limiter and environment bindings cannot certify selected factories', async ({
    assert,
  }) => {
    await withFixture(async (choices, state) => {
      state.files['config/limiter.ts'] =
        "import { defineConfig, stores } from '@adonisjs/limiter'\nstores.memory = () => { throw new Error('broken') }\nexport default defineConfig({ default: 'memory', stores: { memory: stores.memory({}) } })"
      const mutatedFactory = await planSetup(choices, state)
      assert.isTrue(
        mutatedFactory.diagnostics.some(
          ({ field, severity }) => field === 'config/limiter.ts' && severity === 'error'
        )
      )
      state.files['config/limiter.ts'] =
        "import env from '#start/env'\nimport { defineConfig, stores } from '@adonisjs/limiter'\nenv.get = () => 'unknown'\nexport default defineConfig({ default: env.get('LIMITER_STORE', 'memory'), stores: { memory: stores.memory({}) } })"
      const mutatedEnv = await planSetup(choices, state)
      assert.isTrue(
        mutatedEnv.diagnostics.some(
          ({ field, severity }) => field === 'config/limiter.ts' && severity === 'error'
        )
      )
      state.files['config/session.ts'] =
        "import env from '#start/env'\nimport { defineConfig, stores } from '@adonisjs/session'\nenv.get = () => 'cookie'\nconst sessionConfig = defineConfig({ store: env.get('SESSION_DRIVER', 'database'), stores: { database: stores.database() } })\nexport default sessionConfig"
      const mutatedSession = await planSetup(choices, state)
      assert.isTrue(
        mutatedSession.diagnostics.some(
          ({ field, severity }) => field === 'config/session.ts' && severity === 'error'
        )
      )
    })
  })

  test('additional runtime module imports invalidate session and Limiter provenance', async ({
    assert,
  }) => {
    await withFixture(async (choices, state) => {
      state.files['config/session.ts'] =
        "import env from '#start/env'\nimport * as envModule from '#start/env'\nimport { defineConfig, stores } from '@adonisjs/session'\nenvModule.default.get = () => 'cookie'\nconst sessionConfig = defineConfig({ store: env.get('SESSION_DRIVER', 'database'), stores: { database: stores.database() } })\nexport default sessionConfig"
      const session = await planSetup(choices, state)
      assert.isTrue(
        session.diagnostics.some(
          ({ field, severity }) => field === 'config/session.ts' && severity === 'error'
        )
      )
      state.files['config/limiter.ts'] =
        "import { defineConfig, stores } from '@adonisjs/limiter'\nimport * as limiter from '@adonisjs/limiter'\nlimiter.stores.memory = () => { throw new Error('broken') }\nexport default defineConfig({ default: 'memory', stores: { memory: stores.memory({}) } })"
      const limiter = await planSetup(choices, state)
      assert.isTrue(
        limiter.diagnostics.some(
          ({ field, severity }) => field === 'config/limiter.ts' && severity === 'error'
        )
      )
      state.files['config/limiter.ts'] =
        "import env from '#start/env'\nimport { default as otherEnv } from '#start/env'\nimport { defineConfig, stores } from '@adonisjs/limiter'\notherEnv.get = () => 'unknown'\nexport default defineConfig({ default: env.get('LIMITER_STORE', 'memory'), stores: { memory: stores.memory({}) } })"
      const limiterEnv = await planSetup(choices, state)
      assert.isTrue(
        limiterEnv.diagnostics.some(
          ({ field, severity }) => field === 'config/limiter.ts' && severity === 'error'
        )
      )
    })
  })

  test('dynamic module views cannot certify selected session and Limiter factories', async ({
    assert,
  }) => {
    await withFixture(async (choices, state) => {
      state.files['config/session.ts'] =
        "import env from '#start/env'\nimport { defineConfig, stores } from '@adonisjs/session'\nconst other = await import(`#start/env`)\nother.default.get = () => 'cookie'\nconst sessionConfig = defineConfig({ store: env.get('SESSION_DRIVER', 'database'), stores: { database: stores.database() } })\nexport default sessionConfig"
      const session = await planSetup(choices, state)
      assert.isTrue(
        session.diagnostics.some(
          ({ field, severity }) => field === 'config/session.ts' && severity === 'error'
        )
      )
      state.files['config/session.ts'] =
        "import { defineConfig, stores } from '@adonisjs/session'\nconst sessionConfig = defineConfig({ store: 'database', stores: { database: stores.database() } })\nexport default sessionConfig"
      state.files['config/limiter.ts'] =
        "import { defineConfig, stores } from '@adonisjs/limiter'\nconst other = await import('@adonisjs/limiter')\nother.stores.memory = () => { throw new Error('broken') }\nexport default defineConfig({ default: 'memory', stores: { memory: stores.memory({}) } })"
      const limiter = await planSetup(choices, state)
      assert.isTrue(
        limiter.diagnostics.some(
          ({ field, severity }) => field === 'config/limiter.ts' && severity === 'error'
        )
      )
      state.files['config/limiter.ts'] =
        "import { defineConfig, stores } from '@adonisjs/limiter'\nconst moduleName = '@adonisjs/limiter'\nconst other = await import(moduleName)\nother.stores.memory = () => { throw new Error('broken') }\nexport default defineConfig({ default: 'memory', stores: { memory: stores.memory({}) } })"
      const computed = await planSetup(choices, state)
      assert.isTrue(
        computed.diagnostics.some(
          ({ field, severity }) => field === 'config/limiter.ts' && severity === 'error'
        )
      )
      state.files['config/limiter.ts'] =
        "import { defineConfig, stores } from '@adonisjs/limiter'\nconst other = require('@adonisjs/limiter')\nother.stores.memory = () => { throw new Error('broken') }\nexport default defineConfig({ default: 'memory', stores: { memory: stores.memory({}) } })"
      const required = await planSetup(choices, state)
      assert.isTrue(
        required.diagnostics.some(
          ({ field, severity }) => field === 'config/limiter.ts' && severity === 'error'
        )
      )
    })
  })

  test('local Shield wrapper cannot attest CSRF without the framework import', async ({
    assert,
  }) => {
    await withFixture(async (choices, state) => {
      state.files['config/shield.ts'] =
        'const __unbound_define_config__ = (config: any) => ({ csrf: { enabled: false } })\nexport default __unbound_define_config__({ csrf: { enabled: true } })'
      const plan = await planSetup(choices, state)
      assert.isTrue(
        plan.diagnostics.some(
          ({ field, severity }) => field === 'config/shield.ts' && severity === 'error'
        )
      )
    })
  })

  test('maintained Mail requires a selected mailer and remains unverified statically', async ({
    assert,
  }) => {
    await withFixture(async (choices, state) => {
      choices.mail.integration = 'adonisjs-mail'
      choices.mail.transportEnv = 'MAIL_MAILER'
      const previous = process.env.MAIL_MAILER
      process.env.MAIL_MAILER = 'smtp'
      try {
        state.files['config/mail.ts'] =
          "import { defineConfig } from '@adonisjs/mail'\nimport env from '#start/env'\nexport default defineConfig({ default: env.get('MAIL_MAILER'), mailers: {} })"
        const empty = await planSetup(choices, state)
        assert.isTrue(
          empty.diagnostics.some(
            ({ field, severity }) => field === 'config/mail.ts' && severity === 'error'
          )
        )
        state.files['config/mail.ts'] =
          "import { defineConfig } from '@adonisjs/mail'\nimport env from '#start/env'\nexport default defineConfig({ default: env.get('MAIL_MAILER'), mailers: { other: customTransport() } })"
        const wrong = await planSetup(choices, state)
        assert.isTrue(
          wrong.diagnostics.some(
            ({ field, severity }) => field === 'config/mail.ts' && severity === 'error'
          )
        )
        state.files['config/mail.ts'] =
          "import { defineConfig } from '@adonisjs/mail'\nimport env from '#start/env'\nexport default defineConfig({ default: env.get('MAIL_MAILER'), mailers: { smtp: customTransport() } })"
        const selected = await planSetup(choices, state)
        assert.isTrue(
          selected.diagnostics.some(
            ({ field, severity }) => field === 'config/mail.ts' && severity === 'action'
          )
        )
        assert.isFalse(selected.readiness.externalConfigured)
      } finally {
        if (previous === undefined) delete process.env.MAIL_MAILER
        else process.env.MAIL_MAILER = previous
      }
    })
  })

  test('maintained Mail rejects nullish selected values and ambiguous environment imports', async ({
    assert,
  }) => {
    await withFixture(async (choices, state) => {
      choices.mail.integration = 'adonisjs-mail'
      choices.mail.transportEnv = 'MAIL_MAILER'
      const previous = process.env.MAIL_MAILER
      process.env.MAIL_MAILER = 'smtp'
      try {
        for (const value of [
          'null',
          'undefined',
          'void 0',
          '(null as unknown)',
          'null!',
          'undefined!',
          'false',
          '42',
          "'smtp'",
          '[]',
          '{}',
          '({} satisfies object)',
          '(/smtp/ as unknown)',
          '<any>null',
          '(<unknown>null)!',
          '<any>(null as unknown)',
          '(<any>undefined)!',
          '<any>false',
          '<any>({})',
        ]) {
          state.files['config/mail.ts'] =
            `import { defineConfig } from '@adonisjs/mail'\nexport default defineConfig({ default: 'smtp', mailers: { smtp: ${value} } })`
          const invalid = await planSetup(choices, state)
          assert.isTrue(
            invalid.diagnostics.some(
              ({ field, severity, message }) =>
                field === 'config/mail.ts' &&
                severity === 'error' &&
                message.includes('callable transport provider')
            )
          )
          assert.isFalse(invalid.readiness.configurationValid)
        }
        state.files['config/mail.ts'] =
          "import { defineConfig } from '@adonisjs/mail'\nimport env from '#start/env'\nimport * as envModule from '#start/env'\nenvModule.default.get = () => 'other'\nexport default defineConfig({ default: env.get('MAIL_MAILER', 'smtp'), mailers: { smtp: customTransport() } })"
        const ambiguous = await planSetup(choices, state)
        assert.isTrue(
          ambiguous.diagnostics.some(
            ({ field, severity, message }) =>
              field === 'config/mail.ts' && severity === 'error' && message.includes('provenance')
          )
        )
        assert.isFalse(ambiguous.readiness.externalConfigured)
        state.files['config/mail.ts'] =
          "import { defineConfig, transports } from '@adonisjs/mail'\nimport env from '#start/env'\nconst other = await import('#start/env')\nother.default.get = () => 'other'\nexport default defineConfig({ default: env.get('MAIL_MAILER', 'smtp'), mailers: { smtp: transports.smtp({}) } })"
        const dynamicEnv = await planSetup(choices, state)
        assert.isTrue(
          dynamicEnv.diagnostics.some(
            ({ field, severity }) => field === 'config/mail.ts' && severity === 'error'
          )
        )
        state.files['config/mail.ts'] =
          "import { defineConfig, transports } from '@adonisjs/mail'\nexport default defineConfig({ default: 'smtp', mailers: { smtp: transports.smtp({}) } })"
        const native = await planSetup(choices, state)
        assert.isTrue(
          native.diagnostics.some(
            ({ field, severity, message }) =>
              field === 'config/mail.ts' &&
              severity === 'action' &&
              message.includes('Verify the selected')
          )
        )
        assert.isFalse(native.readiness.externalConfigured)
        state.files['config/mail.ts'] =
          "import { defineConfig as mailConfig, transports as mailTransport } from '@adonisjs/mail'\nexport default mailConfig({ default: 'smtp', mailers: { smtp: mailTransport.smtp({}) } })"
        const aliasedNative = await planSetup(choices, state)
        assert.isTrue(
          aliasedNative.diagnostics.some(
            ({ field, severity, message }) =>
              field === 'config/mail.ts' &&
              severity === 'action' &&
              message.includes('Verify the selected')
          )
        )
        state.files['config/mail.ts'] =
          "import { defineConfig } from '@adonisjs/mail'\nexport default defineConfig({ default: 'smtp', mailers: { smtp: (<any>(() => ({})))! } })"
        const callable = await planSetup(choices, state)
        assert.isTrue(
          callable.diagnostics.some(
            ({ field, severity, message }) =>
              field === 'config/mail.ts' &&
              severity === 'action' &&
              message.includes('Verify the selected')
          )
        )
      } finally {
        if (previous === undefined) delete process.env.MAIL_MAILER
        else process.env.MAIL_MAILER = previous
      }
    })
  }).timeout(10_000)

  test('unsafe Mail configuration blocks apply without writing files', async ({ assert }) => {
    await withFixture(async (choices, state, root) => {
      choices.mail.integration = 'adonisjs-mail'
      choices.mail.transportEnv = 'MAIL_MAILER'
      const previous = process.env.MAIL_MAILER
      process.env.MAIL_MAILER = 'smtp'
      const cases = [
        "import { defineConfig } from '@adonisjs/mail'\nexport default defineConfig({ default: 'smtp', mailers: { smtp: <any>null } })",
        "import { defineConfig } from '@adonisjs/mail'\nimport env from '#start/env'\nenv.get = () => 'missing'\nexport default defineConfig({ default: env.get('MAIL_MAILER', 'smtp'), mailers: { smtp: () => ({}) } })",
        "import { defineConfig, transports } from '@adonisjs/mail'\ntransports.smtp = () => null\nexport default defineConfig({ default: 'smtp', mailers: { smtp: transports.smtp({}) } })",
        "import { defineConfig, transports } from '@adonisjs/mail'\nconst config = defineConfig({ default: 'smtp', mailers: { smtp: transports.smtp({}) } })\nconfig.mailers.smtp = null\nexport default config",
        "import { defineConfig } from '@adonisjs/mail'\nconst selected = 'smtp'\nexport default defineConfig({ default: selected, mailers: { smtp: () => ({}) } })",
        "import { defineConfig } from '@adonisjs/mail'\nexport default customConfig({ default: 'smtp', mailers: { smtp: () => ({}) } })",
        "import { defineConfig, transports } from '@adonisjs/mail'\nimport env from '#start/env'\nenv.get = () => 'missing'\nexport default defineConfig({ default: 'smtp', mailers: { smtp: transports.smtp({ host: env.get('MAIL_HOST') }) } })",
        "import { defineConfig } from '@adonisjs/mail'\nexport default defineConfig({ default: 'smtp', mailers: { smtp: false ? () => ({}) : () => ({}) } })",
        "import { defineConfig, transports } from '@adonisjs/mail'\nexport default defineConfig({ default: 'smtp', mailers: { smtp: transports.unknown({}) } })",
      ]
      try {
        for (const mail of cases) {
          state.files['config/mail.ts'] = mail
          const before = await readdir(root)
          const plan = await planSetup(choices, state, { apply: true })
          assert.isTrue(
            plan.diagnostics.some(
              ({ field, severity }) => field === 'config/mail.ts' && severity === 'error'
            ),
            mail
          )
          await assert.rejects(() => applySetup(root, plan), /blocking diagnostics/)
          assert.deepEqual(await readdir(root), before)
        }
      } finally {
        if (previous === undefined) delete process.env.MAIL_MAILER
        else process.env.MAIL_MAILER = previous
      }
    })
  })
})
