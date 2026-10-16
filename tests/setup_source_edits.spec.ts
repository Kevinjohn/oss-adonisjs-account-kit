import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from '@japa/runner'
import { inspectSetup } from '../src/setup/inspect.js'
import { planSetup } from '../src/setup/plan.js'
import { applySetup } from '../src/setup/apply.js'
import { fixture, registerSetupTeardown } from './helpers/setup.js'

test.group('setup source edits', (group) => {
  registerSetupTeardown(group)

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
})
