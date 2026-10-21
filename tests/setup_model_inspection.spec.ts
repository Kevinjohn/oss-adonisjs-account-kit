import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from '@japa/runner'
import { inspectSetup } from '../src/setup/inspect.js'
import { planSetup } from '../src/setup/plan.js'
import { applySetup } from '../src/setup/apply.js'
import { fixture, registerSetupTeardown } from './helpers/setup_project_fixture.js'
import { stock } from './helpers/native_starter_fixture.js'

test.group('setup model and schema safety', (group) => {
  registerSetupTeardown(group)

  /** A setup fixture with the native starter's stock auth, mail, limiter, model and schema. */
  async function stockFixture() {
    const { root, choices } = await fixture()
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
    return {
      root,
      choices,
      manifest,
      schema: await stock('database/schema.ts'),
      user: await stock('app/models/user.ts'),
    }
  }

  test('runtime config, schema and model mutations block setup', async ({ assert }) => {
    const { root, choices } = await stockFixture()
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
  }).timeout(10_000)

  test('schema primary key changes block setup', async ({ assert }) => {
    const { root, choices, schema } = await stockFixture()
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
  }).timeout(10_000)

  test('model primary key overrides block setup', async ({ assert }) => {
    const { root, choices, user } = await stockFixture()
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
  }).timeout(10_000)

  test('string and uuid user ids must match the schema id column', async ({ assert }) => {
    const { root, choices, schema } = await stockFixture()
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
  }).timeout(10_000)

  test('schema table, connection and naming strategy must be proven', async ({ assert }) => {
    const { root, choices, schema, user } = await stockFixture()
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
  }).timeout(10_000)

  test('database import-map redirects block setup', async ({ assert }) => {
    const { root, choices, manifest } = await stockFixture()
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
})
