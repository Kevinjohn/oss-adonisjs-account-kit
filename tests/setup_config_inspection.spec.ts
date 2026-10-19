import { readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from '@japa/runner'
import { inspectSetup } from '../src/setup/inspect.js'
import { planSetup } from '../src/setup/plan.js'
import { applySetup } from '../src/setup/apply.js'
import { fixture, registerSetupTeardown } from './helpers/setup_project_fixture.js'

test.group('setup config inspection', (group) => {
  registerSetupTeardown(group)

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

  test('CSRF prerequisites distinguish inert app bootstrap from active managed endpoint', async ({
    assert,
  }) => {
    const { root, choices } = await fixture()
    choices.authentication!.applicationRouteRevocation = false
    const inert = await planSetup(choices, await inspectSetup(root), {
      apply: true,
      timestamp: 1234,
    })
    assert.deepEqual(inert.endpointLocations, [])
    assert.isTrue(
      inert.prerequisites.some((item) => item.includes('application-owned CSRF bootstrap endpoint'))
    )
    assert.isFalse(inert.prerequisites.some((item) => item.includes('GET /account/auth/csrf')))
    choices.authentication!.applicationRouteRevocation = true
    const active = await planSetup(choices, await inspectSetup(root), {
      apply: true,
      timestamp: 1234,
    })
    assert.isTrue(active.prerequisites.some((item) => item.includes('GET /account/auth/csrf')))
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
})
