import { readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from '@japa/runner'
import { inspectSetup } from '../src/setup/inspect.js'
import { planSetup } from '../src/setup/plan.js'
import { applySetup } from '../src/setup/apply.js'
import { fixture, registerSetupTeardown } from './helpers/setup_project_fixture.js'
import ts from 'typescript'
import { withFixture } from './helpers/setup_prerequisites.js'
import { stripSourceComments } from '../src/setup/strip_source_comments.js'

test.group('setup source edits', (group) => {
  registerSetupTeardown(group)

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

  test('registers the root provider export and keeps a registered legacy path', async ({
    assert,
  }) => {
    const { root, choices } = await fixture()
    await writeFile(join(root, 'adonisrc.ts'), 'export default { providers: [] }\n')
    const fresh = await planSetup(choices, await inspectSetup(root))
    const freshRc = fresh.changes.find(({ path }) => path === 'adonisrc.ts')!.content
    assert.include(freshRc, "() => import('adonisjs-account-kit/account_kit_provider'),")
    assert.notInclude(freshRc, 'adonisjs-account-kit/providers/account_kit_provider')

    await writeFile(
      join(root, 'adonisrc.ts'),
      "export default { providers: [() => import('adonisjs-account-kit/providers/account_kit_provider')] }\n"
    )
    const legacy = await planSetup(choices, await inspectSetup(root))
    const legacyRc = legacy.changes.find(({ path }) => path === 'adonisrc.ts')!.content
    assert.notInclude(legacyRc, "import('adonisjs-account-kit/account_kit_provider')")
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
})

test.group('setup middleware edits', () => {
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
})
