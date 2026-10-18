import {
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
import { inspectSetup } from '../src/setup/inspect.js'
import { planSetup } from '../src/setup/plan.js'
import { applySetup } from '../src/setup/apply.js'
import { cleanupRoots, fixture, registerSetupTeardown } from './helpers/setup.js'
import { withFixture } from './helpers/setup_prerequisites.js'

test.group('setup model inspection', (group) => {
  registerSetupTeardown(group)

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

  test('every supported User inheritance form checks its final default table', async ({
    assert,
  }) => {
    const { root, choices } = await fixture()
    const direct = (table: string) =>
      `import { BaseModel, column } from '@adonisjs/lucid/orm'\nexport default class User extends BaseModel { ${table}@column({ isPrimary: true }) declare id: number }\n`
    const composed = (table: string) =>
      `import { BaseModel, column } from '@adonisjs/lucid/orm'\nimport { compose } from '@adonisjs/core/helpers'\nimport { withAuthFinder } from '@adonisjs/auth/mixins/lucid'\nimport hash from '@adonisjs/core/services/hash'\nexport default class User extends compose(BaseModel, withAuthFinder(hash)) { ${table}@column({ isPrimary: true }) declare id: number }\n`
    for (const model of [direct, composed]) {
      for (const [table, selected, blocked] of [
        ['', 'users', false],
        ['', 'members', true],
        ["static table = 'members'; ", 'members', false],
      ] as const) {
        choices.user.table = selected
        await writeFile(join(root, 'app/models/user.ts'), model(table))
        const plan = await planSetup(choices, await inspectSetup(root), {
          apply: true,
          timestamp: 1234,
        })
        const errors = plan.diagnostics.filter(
          ({ field, severity }) => field === 'user.table' && severity === 'error'
        )
        assert.equal(errors.length > 0, blocked, JSON.stringify(plan.diagnostics))
        if (blocked) {
          await assert.rejects(() => applySetup(root, plan), /blocking diagnostics/)
          const files = await readdir(join(root, 'config'))
          assert.notInclude(files, 'account_kit_setup.json')
        }
      }
      choices.user.table = 'users'
      await writeFile(
        join(root, 'app/models/user.ts'),
        model('').replace('class User', 'class CustomUser')
      )
      const custom = await planSetup(choices, await inspectSetup(root), {
        apply: true,
        timestamp: 1234,
      })
      assert.isTrue(
        custom.diagnostics.some(
          ({ field, severity }) => field === 'user.table' && severity === 'error'
        )
      )
      await assert.rejects(() => applySetup(root, custom), /blocking diagnostics/)
      await writeFile(
        join(root, 'app/models/user.ts'),
        model("static table = 'users'; ").replace('class User', 'class CustomUser')
      )
      const explicit = await planSetup(choices, await inspectSetup(root), {
        apply: true,
        timestamp: 1234,
      })
      assert.isFalse(
        explicit.diagnostics.some(
          ({ field, severity }) => field === 'user.table' && severity === 'error'
        ),
        JSON.stringify(explicit.diagnostics)
      )
    }
  })

  test('selected token setup requires a proven model provider and matching native guard property', async ({
    assert,
  }) => {
    const { root, choices } = await fixture()
    choices.authentication!.strategy = 'access_tokens'
    choices.authentication!.guard = 'api'
    delete choices.authentication!.session
    choices.authentication!.token = { revocation: true, lifetime: '1d', abilities: ['*'] }
    const modelPath = join(root, 'app/models/user.ts')
    const authPath = join(root, 'config/auth.ts')
    const nativeModel = await readFile(modelPath, 'utf8')
    const nativeAuth = await readFile(authPath, 'utf8')
    const modelCases = [
      nativeModel.replace('DbAccessTokensProvider.forModel(User)', '{}'),
      nativeModel.replace('DbAccessTokensProvider.forModel(User)', 'opaqueProvider'),
      nativeModel.replace(
        'DbAccessTokensProvider.forModel(User)',
        'DbAccessTokensProvider.forModel(Other)'
      ),
      nativeModel.replace('DbAccessTokensProvider.forModel(User)', 'OtherProvider.forModel(User)'),
      `${nativeModel}\nDbAccessTokensProvider.forModel = () => ({})\n`,
    ]
    for (const model of modelCases) {
      await writeFile(modelPath, model)
      const plan = await planSetup(choices, await inspectSetup(root), {
        apply: true,
        timestamp: 1234,
      })
      assert.isTrue(
        plan.diagnostics.some(
          ({ field, severity }) => field === 'user.model' && severity === 'error'
        ),
        model
      )
      await assert.rejects(() => applySetup(root, plan), /blocking diagnostics/)
      assert.notInclude(await readdir(join(root, 'config')), 'account_kit_setup.json')
    }
    await writeFile(
      modelPath,
      nativeModel
        .replace(
          'import { DbAccessTokensProvider }',
          'import { DbAccessTokensProvider as NativeTokens }'
        )
        .replace('DbAccessTokensProvider.forModel(User)', 'NativeTokens.forModel(User)')
    )
    const aliased = await planSetup(choices, await inspectSetup(root), {
      apply: true,
      timestamp: 1234,
    })
    assert.isFalse(
      aliased.diagnostics.some(
        ({ field, severity }) => field === 'user.model' && severity === 'error'
      ),
      JSON.stringify(aliased.diagnostics)
    )
    await writeFile(
      modelPath,
      nativeModel.replace(
        'DbAccessTokensProvider.forModel(User)',
        '(DbAccessTokensProvider.forModel(User) as typeof DbAccessTokensProvider)'
      )
    )
    const wrapped = await planSetup(choices, await inspectSetup(root), {
      apply: true,
      timestamp: 1234,
    })
    assert.isFalse(
      wrapped.diagnostics.some(
        ({ field, severity }) => field === 'user.model' && severity === 'error'
      ),
      JSON.stringify(wrapped.diagnostics)
    )
    await writeFile(modelPath, nativeModel)
    for (const configured of ["tokens: 'otherTokens'", 'tokens: tokenProperty', '']) {
      await writeFile(
        authPath,
        nativeAuth.replace("tokens: 'accessTokens',", configured ? `${configured},` : '')
      )
      const plan = await planSetup(choices, await inspectSetup(root), {
        apply: true,
        timestamp: 1234,
      })
      assert.isTrue(
        plan.diagnostics.some(
          ({ field, severity }) => field === 'authentication.guard' && severity === 'error'
        ),
        configured
      )
      await assert.rejects(() => applySetup(root, plan), /blocking diagnostics/)
      assert.notInclude(await readdir(join(root, 'config')), 'account_kit_setup.json')
    }
    await writeFile(authPath, nativeAuth)
    const valid = await planSetup(choices, await inspectSetup(root), {
      apply: true,
      timestamp: 1234,
    })
    assert.isFalse(
      valid.diagnostics.some(
        ({ field, severity }) =>
          ['user.model', 'authentication.guard'].includes(field) && severity === 'error'
      ),
      JSON.stringify(valid.diagnostics)
    )

    await writeFile(
      authPath,
      nativeAuth
        .replace('tokensUserProvider }', 'tokensUserProvider as NativeUserProvider }')
        .replace('tokensUserProvider({', 'NativeUserProvider({')
    )
    const aliasedGuard = await planSetup(choices, await inspectSetup(root), {
      apply: true,
      timestamp: 1234,
    })
    assert.isFalse(
      aliasedGuard.diagnostics.some(
        ({ field, severity }) => field === 'authentication.guard' && severity === 'error'
      ),
      JSON.stringify(aliasedGuard.diagnostics)
    )

    choices.authentication!.strategy = 'session'
    choices.authentication!.guard = 'web'
    delete choices.authentication!.token
    choices.authentication!.session = {
      secureCookie: true,
      csrf: true,
      originChecked: true,
      persistentStore: true,
    }
    await writeFile(modelPath, nativeModel.replace('DbAccessTokensProvider.forModel(User)', '{}'))
    const session = await planSetup(choices, await inspectSetup(root), {
      apply: true,
      timestamp: 1234,
    })
    assert.isFalse(
      session.diagnostics.some(
        ({ field, severity }) => field === 'user.model' && severity === 'error'
      ),
      JSON.stringify(session.diagnostics)
    )
  })

  test('selected database client wins over unused connections', async ({ assert }) => {
    const { root, choices } = await fixture()
    await writeFile(
      join(root, 'config/database.ts'),
      "import { defineConfig } from '@adonisjs/lucid'\nexport default defineConfig({ connection: 'mssql', connections: { sqlite: { client: 'better-sqlite3' }, mssql: { client: 'mssql' } } })\n"
    )
    const plan = await planSetup(choices, await inspectSetup(root))
    const state = await inspectSetup(root)
    assert.equal(state.database, 'unsupported')
    assert.include(
      plan.diagnostics.map(({ field }) => field),
      'database.client'
    )
  })

  test('a MySQL 8.4 default connection is supported', async ({ assert }) => {
    const { root, choices } = await fixture()
    await writeFile(
      join(root, 'config/database.ts'),
      "import { defineConfig } from '@adonisjs/lucid'\nexport default defineConfig({ connection: 'mysql', connections: { mysql: { client: 'mysql2' } } })\n"
    )
    const state = await inspectSetup(root)
    assert.equal(state.database, 'mysql')
    const plan = await planSetup(choices, state)
    assert.notInclude(
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
})

test.group('setup prerequisite inspection', () => {
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
})
