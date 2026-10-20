import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test } from '@japa/runner'
import { ListLoader } from '@adonisjs/core/ace'
import Configure from '@adonisjs/core/commands/configure'
import { IgnitorFactory } from '@adonisjs/core/factories'
import { RuntimeException } from '@adonisjs/core/exceptions'
import { configure, migrationNames, migrationSchema } from '../configure.js'

test('configures the package idempotently without replacing application-owned files', async ({
  assert,
}) => {
  const root = await mkdtemp(join(tmpdir(), 'account-kit-configure-'))
  try {
    await writeFile(
      join(root, 'package.json'),
      '{"type":"module","devDependencies":{"@adonisjs/assembler":"8.5.2"}}'
    )
    await writeFile(join(root, 'tsconfig.json'), '{}')
    await writeFile(
      join(root, 'adonisrc.ts'),
      "import { defineConfig } from '@adonisjs/core/app'\nexport default defineConfig({ providers: [] })\n"
    )
    await symlink(
      fileURLToPath(new URL('../node_modules', import.meta.url)),
      join(root, 'node_modules')
    )

    const envPath = join(root, 'start', 'env.ts')
    await mkdir(join(root, 'start'), { recursive: true })
    await writeFile(
      envPath,
      "import { Env } from '@adonisjs/core/env'\n\nexport default await Env.create(new URL('../', import.meta.url), {\n  NODE_ENV: Env.schema.enum(['development', 'production', 'test'] as const),\n})\n"
    )
    const configDirectory = join(root, 'config')
    const migrationsDirectory = join(root, 'database', 'migrations')
    await mkdir(configDirectory, { recursive: true })
    await mkdir(migrationsDirectory, { recursive: true })
    const configPath = join(configDirectory, 'account_kit.ts')
    const existingConfig = 'export default { ownerSetting: true }\n'
    const existingMigrationPath = join(
      migrationsDirectory,
      'custom_account_kit_create_password_reset_tokens.ts'
    )
    const existingMigration = '// application-owned migration\n'
    await writeFile(existingMigrationPath, existingMigration)

    const packageEntry = process.env.ACCOUNT_KIT_PACKAGE_ENTRY
      ? pathToFileURL(process.env.ACCOUNT_KIT_PACKAGE_ENTRY).href
      : new URL('../index.ts', import.meta.url).href
    const importer = (specifier: string) =>
      specifier === 'adonisjs-account-kit' ? import(packageEntry) : import(specifier)
    const ignitor = new IgnitorFactory()
      .withCoreProviders()
      .withCoreConfig()
      .merge({
        rcFileContents: {
          providers: [],
          commands: [async () => new ListLoader([Configure])],
        },
      })
      .create(pathToFileURL(`${root}/`), { importer })

    await ignitor.ace().handle(['configure', 'adonisjs-account-kit', '--force'])
    const generatedConfig = await readFile(configPath, 'utf8')
    assert.include(generatedConfig, "from 'adonisjs-account-kit'")
    assert.include(generatedConfig, "import('#models/user')")
    assert.include(generatedConfig, "env.get('APP_URL').endsWith('/')")
    assert.include(generatedConfig, "new URL('account-kit/' + path")
    assert.include(generatedConfig, "registration: { availability: 'open' }")
    assert.notInclude(generatedConfig.match(/enabled: \[[^\]]*\]/s)?.[0], "'invitations'")
    const firstEnv = await readFile(envPath, 'utf8')
    assert.equal(
      firstEnv.match(/APP_URL: Env\.schema\.string\(\{ format: 'url', tld: false \}\)/g)?.length,
      1
    )
    assert.equal(await readFile(existingMigrationPath, 'utf8'), existingMigration)

    const firstMigrationFiles = await readdir(migrationsDirectory)
    let migrationFiles = firstMigrationFiles.sort()
    assert.lengthOf(migrationFiles, 11)
    assert.deepEqual(
      migrationFiles
        .map((filename) => filename.replace(/^.*_account_kit_/, '').replace(/\.ts$/, ''))
        .sort(),
      [
        'add_account_columns_to_users',
        'create_account_invitations',
        'create_account_sessions',
        'create_account_transaction_lock',
        'create_email_verification_tokens',
        'create_login_link_tokens',
        'create_password_reset_tokens',
        'create_social_handoff_codes',
        'create_social_identities',
        'create_social_sensitive_proofs',
        'create_social_transactions',
      ]
    )
    const firstRcContents = await readFile(join(root, 'adonisrc.ts'), 'utf8')
    assert.equal(
      firstRcContents.match(/adonisjs-account-kit\/providers\/account_kit_provider/g)?.length,
      1
    )

    const generatedFiles = await Promise.all(
      migrationFiles.map(async (filename) => [
        filename,
        await readFile(join(migrationsDirectory, filename), 'utf8'),
      ])
    )
    for (const [filename, contents] of generatedFiles) {
      const tableName = filename.match(/^\d+_account_kit_create_(.+)\.ts$/)?.[1]
      if (!tableName) continue
      assert.include(contents, `protected tableName = '${tableName}'`)
      assert.include(contents, 'createTable(this.tableName,')
      assert.include(contents, 'dropTable(this.tableName)')
    }
    await writeFile(configPath, existingConfig)
    await ignitor.ace().handle(['configure', 'adonisjs-account-kit', '--force'])

    assert.equal(await readFile(configPath, 'utf8'), existingConfig)
    const secondMigrationFiles = await readdir(migrationsDirectory)
    migrationFiles = secondMigrationFiles.sort()
    assert.deepEqual(
      await Promise.all(
        migrationFiles.map(async (filename) => [
          filename,
          await readFile(join(migrationsDirectory, filename), 'utf8'),
        ])
      ),
      generatedFiles
    )
    const secondEnv = await readFile(envPath, 'utf8')
    assert.equal(secondEnv, firstEnv)
    const secondRcContents = await readFile(join(root, 'adonisrc.ts'), 'utf8')
    assert.equal(
      secondRcContents.match(/adonisjs-account-kit\/providers\/account_kit_provider/g)?.length,
      1
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}).timeout(10_000)

function fakeCommand(root: string, parsedFlags: Record<string, string>) {
  const calls = {
    migrations: [] as Array<Record<string, unknown>>,
    envValidations: 0,
    errors: [] as string[],
  }
  const codemods = {
    overwriteExisting: true,
    async makeUsingStub(_root: string, name: string, data: Record<string, unknown>) {
      if (name.startsWith('migrations/'))
        calls.migrations.push(data.migration as Record<string, unknown>)
    },
    async updateRcFile(
      update: (rcFile: { addProvider(name: string): void; addCommand(name: string): void }) => void
    ) {
      update({ addProvider() {}, addCommand() {} })
    },
    async defineEnvValidations() {
      calls.envValidations++
    },
  }
  const command = {
    parsedFlags,
    exitCode: undefined as number | undefined,
    stubsRoot: fileURLToPath(new URL('../stubs', import.meta.url)),
    app: { makePath: (...parts: string[]) => join(root, ...parts) },
    logger: {
      info() {},
      logError(message: string) {
        calls.errors.push(message)
      },
    },
    async createCodemods() {
      return codemods
    },
  }
  return { command, calls }
}

test('configure passes dashed CLI schema flags into generated migrations', async ({ assert }) => {
  const root = await mkdtemp(join(tmpdir(), 'account-kit-schema-flags-'))
  try {
    await mkdir(join(root, 'database', 'migrations'), { recursive: true })

    for (const [parsedFlags, usersTable, userIdColumn] of [
      [{ 'users-table': 'order', 'user-id-type': 'uuid' }, 'order', "table.uuid('user_id')"],
      [
        { 'users-table': 'group', 'user-id-type': 'string' },
        'group',
        "table.string('user_id', 254)",
      ],
      [
        { usersTable: 'group', userIdType: 'string' },
        'users',
        "table.integer('user_id').unsigned()",
      ],
    ] as const) {
      const { command, calls } = fakeCommand(root, parsedFlags)
      await configure(command as unknown as Configure)
      assert.isUndefined(command.exitCode)
      assert.lengthOf(calls.migrations, migrationNames.length)
      for (const migration of calls.migrations) {
        assert.equal(migration.usersTable, JSON.stringify(usersTable))
        assert.equal(migration.userIdColumn, userIdColumn)
      }
      // No start/env.ts exists here: configure leaves reporting that to the codemod.
      assert.equal(calls.envValidations, 1)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('configure reports invalid schema flags with exit code 1 and generates nothing', async ({
  assert,
}) => {
  for (const [parsedFlags, message] of [
    [{ 'users-table': 'bad-name' }, 'account_kit: users-table must be a plain SQL identifier'],
    [{ 'user-id-type': 'bigint' }, 'account_kit: user-id-type must be integer, string or uuid'],
  ] as const) {
    const { command, calls } = fakeCommand(tmpdir(), parsedFlags)
    await configure(command as unknown as Configure)
    assert.equal(command.exitCode, 1)
    assert.deepEqual(calls.errors, [message])
    assert.lengthOf(calls.migrations, 0)
    assert.equal(calls.envValidations, 0)
  }
})

test('migrationSchema reports invalid schema flags with RuntimeException', ({ assert }) => {
  assert.throws(() => migrationSchema('bad-name'), RuntimeException)
  assert.throws(() => migrationSchema('users', 'bigint' as never), RuntimeException)
})
