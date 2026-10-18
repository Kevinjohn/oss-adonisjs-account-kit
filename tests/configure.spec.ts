import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test } from '@japa/runner'
import { ListLoader } from '@adonisjs/core/ace'
import Configure from '@adonisjs/core/commands/configure'
import { IgnitorFactory } from '@adonisjs/core/factories'

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
    assert.lengthOf(migrationFiles, 12)
    assert.deepEqual(
      migrationFiles
        .map((filename) => filename.replace(/^.*_account_kit_/, '').replace(/\.ts$/, ''))
        .sort(),
      [
        'add_credentials_changed_at_to_users',
        'add_email_verified_at_to_users',
        'add_social_identity_confirmation',
        'create_account_email_changes',
        'create_account_invitations',
        'create_account_transaction_lock',
        'create_login_link_tokens',
        'create_password_reset_tokens',
        'create_social_identities',
        'create_social_transactions',
        'evolve_identity_contract',
        'retire_account_email_changes',
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
