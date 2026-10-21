import { readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from '@japa/runner'
import { inspectSetup } from '../src/setup/inspect.js'
import { planSetup } from '../src/setup/plan.js'
import { applySetup } from '../src/setup/apply.js'
import { parseSetupChoices } from '../src/setup/parse.js'
import { fixture, registerSetupTeardown } from './helpers/setup_project_fixture.js'
import { withFixture } from './helpers/setup_prerequisites.js'

test.group('setup choice validation', (group) => {
  registerSetupTeardown(group)

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

  test('resolves selected mail origins from the application environment file', async ({
    assert,
  }) => {
    const { root, choices } = await fixture()
    await writeFile(
      join(root, '.env'),
      'APP_URL=https://accounts.example.test\nFRONTEND_URL=https://app.example.test\n'
    )
    const plan = await planSetup(choices, await inspectSetup(root), {
      production: true,
      env: {},
    })
    assert.notInclude(
      plan.diagnostics
        .filter(({ field }) => field.startsWith('mail.'))
        .map(({ message }) => message),
      'APP_URL must be set before readiness can pass'
    )
    assert.notInclude(
      plan.diagnostics.map(({ field }) => field),
      'mail.backendOriginEnv'
    )
    assert.notInclude(
      plan.diagnostics.map(({ field }) => field),
      'mail.frontendOriginEnv'
    )
  })

  test('resolves named alternate mail origins and preserves process precedence', async ({
    assert,
  }) => {
    const { root, choices } = await fixture()
    choices.mail.backendOriginEnv = 'ACCOUNT_BACKEND_ORIGIN'
    await writeFile(
      join(root, '.env'),
      'ACCOUNT_BACKEND_ORIGIN=http://file.example.test\nFRONTEND_URL=https://app.example.test\n'
    )
    const plan = await planSetup(choices, await inspectSetup(root), {
      production: true,
      env: { ACCOUNT_BACKEND_ORIGIN: 'https://process.example.test' },
    })
    assert.notInclude(
      plan.diagnostics.map(({ field }) => field),
      'mail.backendOriginEnv'
    )
  })

  test('rejects insecure production origins found only in an environment file', async ({
    assert,
  }) => {
    const { root, choices } = await fixture()
    await writeFile(
      join(root, '.env'),
      'APP_URL=http://accounts.example.test\nFRONTEND_URL=https://app.example.test\n'
    )
    const plan = await planSetup(choices, await inspectSetup(root), {
      production: true,
      env: {},
    })
    assert.isTrue(
      plan.diagnostics.some(
        ({ field, severity, message }) =>
          field === 'mail.backendOriginEnv' && severity === 'error' && /HTTPS/i.test(message)
      )
    )
    assert.notInclude(JSON.stringify(plan.diagnostics), 'accounts.example.test')
  })

  test('reports an absent selected origin as an action diagnostic', async ({ assert }) => {
    const { root, choices } = await fixture()
    const plan = await planSetup(choices, await inspectSetup(root), { env: {} })
    assert.isTrue(
      plan.diagnostics.some(
        ({ field, severity, message }) =>
          field === 'mail.backendOriginEnv' &&
          severity === 'action' &&
          /APP_URL must be set/.test(message)
      )
    )
  })

  test('explains when a selected origin cannot be inspected safely', async ({ assert }) => {
    const { root, choices } = await fixture()
    await writeFile(
      join(root, '.env'),
      'APP_URL=https://first.example.test\nAPP_URL=https://second.example.test\n'
    )
    const plan = await planSetup(choices, await inspectSetup(root), { env: {} })
    const diagnostic = plan.diagnostics.find(({ field }) => field === 'mail.backendOriginEnv')
    assert.isDefined(diagnostic)
    assert.match(diagnostic!.message, /could not be inspected safely.*ambiguous/i)
    assert.notMatch(diagnostic!.message, /first\.example\.test|second\.example\.test/)
  })

  test('reports an interpolated selected origin as an action, not an error', async ({ assert }) => {
    const { root, choices } = await fixture()
    await writeFile(
      join(root, '.env'),
      'HOST=localhost\nPORT=3333\nAPP_URL=http://${HOST}:${PORT}\nFRONTEND_URL=https://app.example.test\n'
    )
    for (const production of [false, true]) {
      const plan = await planSetup(choices, await inspectSetup(root), { production, env: {} })
      const diagnostic = plan.diagnostics.find(({ field }) => field === 'mail.backendOriginEnv')
      assert.equal(diagnostic?.severity, 'action')
      assert.match(diagnostic!.message, /APP_URL refers to other values/)
    }
  })

  test('resolves selected social callback origins from an environment file', async ({ assert }) => {
    const { root, choices } = await fixture()
    choices.features.push('socialAuthentication', 'registration', 'emailVerification')
    choices.policy.registration = 'open'
    choices.social = {
      status: 'enabled',
      providers: ['google'],
      callbackOriginEnv: 'SOCIAL_CALLBACK_ORIGIN',
      callbackPath: '/account-kit/auth/oauth/{provider}/callback',
      credentials: {
        google: { clientIdEnv: 'GOOGLE_CLIENT_ID', clientSecretEnv: 'GOOGLE_CLIENT_SECRET' },
      },
    }
    await writeFile(
      join(root, '.env'),
      'APP_URL=https://accounts.example.test\nFRONTEND_URL=https://app.example.test\nSOCIAL_CALLBACK_ORIGIN=https://social.example.test\n'
    )
    const plan = await planSetup(choices, await inspectSetup(root), { env: {} })
    assert.notInclude(
      plan.diagnostics.map(({ field }) => field),
      'social.callbackOriginEnv'
    )
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
})
