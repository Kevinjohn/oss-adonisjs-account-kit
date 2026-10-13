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

    const configDirectory = join(root, 'config')
    const migrationsDirectory = join(root, 'database', 'migrations')
    await mkdir(configDirectory, { recursive: true })
    await mkdir(migrationsDirectory, { recursive: true })
    const configPath = join(configDirectory, 'account_kit.ts')
    const existingConfig = 'export default { ownerSetting: true }\n'
    const existingMigrationPath = join(
      migrationsDirectory,
      'custom_account_kit_create_account_recovery_tokens.ts'
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
    assert.include(generatedConfig, "from '#models/user'")
    assert.equal(await readFile(existingMigrationPath, 'utf8'), existingMigration)

    const firstMigrationFiles = await readdir(migrationsDirectory)
    let migrationFiles = firstMigrationFiles.sort()
    assert.lengthOf(migrationFiles, 4)
    assert.deepEqual(
      migrationFiles
        .map((filename) => filename.replace(/^.*_account_kit_/, '').replace(/\.ts$/, ''))
        .sort(),
      [
        'add_email_verified_at_to_users',
        'create_account_email_changes',
        'create_account_invitations',
        'create_account_recovery_tokens',
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
    const secondRcContents = await readFile(join(root, 'adonisrc.ts'), 'utf8')
    assert.equal(
      secondRcContents.match(/adonisjs-account-kit\/providers\/account_kit_provider/g)?.length,
      1
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}).timeout(10_000)
