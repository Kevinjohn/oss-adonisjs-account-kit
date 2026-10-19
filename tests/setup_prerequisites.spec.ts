import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from '@japa/runner'
import ts from 'typescript'
import { planSetup } from '../src/setup/plan.js'
import { stripSourceComments } from '../src/setup/strip_source_comments.js'
import { withFixture } from './helpers/setup_prerequisites.js'

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
})
