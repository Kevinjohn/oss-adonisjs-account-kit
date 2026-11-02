import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test } from '@japa/runner'
import { ListLoader } from '@adonisjs/core/ace'
import Configure from '@adonisjs/core/commands/configure'
import { IgnitorFactory } from '@adonisjs/core/factories'
import { RuntimeException } from '@adonisjs/core/exceptions'
import { CodeTransformer } from '@adonisjs/assembler/code_transformer'
import { configure, migrationNames, migrationSchema } from '../configure.js'

async function createConfigureProject() {
  const root = await mkdtemp(join(tmpdir(), 'account-kit-configure-'))
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
  const packageEntry = process.env.ACCOUNT_KIT_PACKAGE_ENTRY
    ? pathToFileURL(process.env.ACCOUNT_KIT_PACKAGE_ENTRY).href
    : new URL('../index.ts', import.meta.url).href
  const importer = (specifier: string) =>
    specifier === 'adonisjs-account-kit' ? import(packageEntry) : import(specifier)
  const ignitorFor = (rootDirectory: string) =>
    new IgnitorFactory()
      .withCoreProviders()
      .withCoreConfig()
      .merge({
        rcFileContents: {
          providers: [],
          commands: [async () => new ListLoader([Configure])],
        },
      })
      .create(pathToFileURL(`${rootDirectory}/`), { importer })

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
  const existingMigrationPath = join(
    migrationsDirectory,
    'custom_account_kit_create_password_reset_tokens.ts'
  )
  const existingMigration = '// application-owned migration\n'
  await writeFile(existingMigrationPath, existingMigration)

  return {
    root,
    envPath,
    configDirectory,
    migrationsDirectory,
    configPath,
    existingMigrationPath,
    existingMigration,
    ignitorFor,
  }
}

test('configures the package idempotently without replacing application-owned files', async ({
  assert,
}) => {
  const project = await createConfigureProject()
  const {
    root,
    envPath,
    migrationsDirectory,
    configPath,
    existingMigrationPath,
    existingMigration,
    ignitorFor,
  } = project
  const originalProcessExitCode = process.exitCode
  const existingConfig = 'export default { ownerSetting: true }\n'
  try {
    const rcPath = join(root, 'adonisrc.ts')
    const ignitor = ignitorFor(root)

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
    assert.equal(firstRcContents.match(/adonisjs-account-kit\/account_kit_provider/g)?.length, 1)

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
    assert.equal(secondRcContents.match(/adonisjs-account-kit\/account_kit_provider/g)?.length, 1)

    await writeFile(
      rcPath,
      [
        "import { defineConfig as makeConfig } from '@adonisjs/core/app'",
        'const defineConfig = makeConfig',
        "// 'adonisjs-account-kit/providers/account_kit_provider'",
        "/* 'adonisjs-account-kit/providers/account_kit_provider' */",
        "const note = 'adonisjs-account-kit/providers/account_kit_provider'",
        'const template = `adonisjs-account-kit/providers/account_kit_provider`',
        "export default defineConfig({ note, template, providers: [() => import('adonisjs-account-kit/providers/account_kit_provider_extra')] })",
        '',
      ].join('\n')
    )
    await ignitor.ace().handle(['configure', 'adonisjs-account-kit', '--force'])
    let rcContents = await readFile(rcPath, 'utf8')
    assert.equal(
      rcContents.match(/import\('adonisjs-account-kit\/account_kit_provider'\)/g)?.length,
      1
    )
    assert.equal(
      rcContents.match(/import\('adonisjs-account-kit\/providers\/account_kit_provider'\)/g)
        ?.length ?? 0,
      0
    )
    assert.include(
      rcContents,
      "import('adonisjs-account-kit/providers/account_kit_provider_extra')"
    )

    await writeFile(
      rcPath,
      [
        "import { defineConfig } from '@adonisjs/core/app'",
        "export default defineConfig({ providers: [{ file: () => import('adonisjs-account-kit/providers/account_kit_provider'), environment: ['console'] }] })",
        '',
      ].join('\n')
    )
    await ignitor.ace().handle(['configure', 'adonisjs-account-kit', '--force'])
    rcContents = await readFile(rcPath, 'utf8')
    assert.equal(
      rcContents.match(/import\('adonisjs-account-kit\/providers\/account_kit_provider'\)/g)
        ?.length,
      1
    )
    assert.equal(
      rcContents.match(/import\('adonisjs-account-kit\/account_kit_provider'\)/g)?.length ?? 0,
      0
    )

    await writeFile(
      rcPath,
      [
        "import { defineConfig } from '@adonisjs/core/app'",
        "export default defineConfig({ providers: [{ file: () => { return import('adonisjs-account-kit/providers/account_kit_provider') }, environment: ['console'] }] })",
        '',
      ].join('\n')
    )
    await ignitor.ace().handle(['configure', 'adonisjs-account-kit', '--force'])
    rcContents = await readFile(rcPath, 'utf8')
    assert.equal(
      rcContents.match(/import\('adonisjs-account-kit\/providers\/account_kit_provider'\)/g)
        ?.length,
      1
    )
    assert.equal(
      rcContents.match(/import\('adonisjs-account-kit\/account_kit_provider'\)/g)?.length ?? 0,
      0
    )

    await writeFile(
      rcPath,
      [
        "import { defineConfig } from '@adonisjs/core/app'",
        "export default defineConfig({ providers: [{ file: () => { return import('adonisjs-account-kit/account_kit_provider') }, environment: ['console'] }] })",
        '',
      ].join('\n')
    )
    await ignitor.ace().handle(['configure', 'adonisjs-account-kit', '--force'])
    rcContents = await readFile(rcPath, 'utf8')
    assert.equal(
      rcContents.match(/import\('adonisjs-account-kit\/account_kit_provider'\)/g)?.length,
      1
    )

    await writeFile(
      rcPath,
      "import { defineConfig } from '@adonisjs/core/app'\nexport default defineConfig({ providers: [() => import('adonisjs-account-kit/account_kit_provider')] })\n"
    )
    await ignitor.ace().handle(['configure', 'adonisjs-account-kit', '--force'])
    rcContents = await readFile(rcPath, 'utf8')
    assert.equal(
      rcContents.match(/import\('adonisjs-account-kit\/account_kit_provider'\)/g)?.length,
      1
    )

    await writeFile(
      rcPath,
      "import { defineConfig } from '@adonisjs/core/app'\nexport default defineConfig({})\n"
    )
    await ignitor.ace().handle(['configure', 'adonisjs-account-kit', '--force'])
    rcContents = await readFile(rcPath, 'utf8')
    assert.equal(
      rcContents.match(/import\('adonisjs-account-kit\/account_kit_provider'\)/g)?.length,
      1
    )
  } finally {
    process.exitCode = originalProcessExitCode
    await rm(root, { recursive: true, force: true })
  }
}).timeout(30_000)

test('recovers real configure runs with registered dynamic providers', async ({ assert }) => {
  const project = await createConfigureProject()
  const { root, envPath, configDirectory, migrationsDirectory, configPath, ignitorFor } = project
  const originalProcessExitCode = process.exitCode
  try {
    const rcPath = join(root, 'adonisrc.ts')
    const dynamicRcWithoutAccountKit = [
      "import { defineConfig } from '@adonisjs/core/app'",
      'const applicationProviders = () => [() => import("application/provider")] as const',
      'const applicationConfig = { providers: applicationProviders(), commands: [() => import("application/commands")] }',
      'export default defineConfig(applicationConfig)',
      '',
    ].join('\n')
    await writeFile(rcPath, dynamicRcWithoutAccountKit)
    const envBeforeRecovery = await readFile(envPath, 'utf8')
    const failedConfigure = ignitorFor(root)
    await failedConfigure.ace().handle(['configure', 'adonisjs-account-kit', '--force'])
    assert.equal(process.exitCode, 1)
    process.exitCode = originalProcessExitCode
    assert.equal(await readFile(rcPath, 'utf8'), dynamicRcWithoutAccountKit)
    const configFilesAfterFailure = await readdir(configDirectory)
    const migrationFilesAfterFailure = await readdir(migrationsDirectory)
    assert.deepEqual(configFilesAfterFailure.sort(), [])
    assert.deepEqual(migrationFilesAfterFailure.sort(), [
      'custom_account_kit_create_password_reset_tokens.ts',
    ])
    assert.equal(await readFile(envPath, 'utf8'), envBeforeRecovery)

    const dynamicRcWithAccountKit = [
      "import { defineConfig } from '@adonisjs/core/app'",
      'const applicationProviders = () => [() => import("application/provider"), () => import("adonisjs-account-kit/account_kit_provider")] as const',
      'const applicationConfig = { providers: applicationProviders(), commands: [() => import("application/commands")] }',
      'export default defineConfig({ ...applicationConfig, commands: [...(applicationConfig.commands ?? [])], providers: applicationConfig.providers })',
      '',
    ].join('\n')
    await writeFile(rcPath, dynamicRcWithAccountKit)
    const recoveredConfigure = await ignitorFor(root)
    await recoveredConfigure
      .ace()
      .handle(['configure', 'adonisjs-account-kit', '--force', '--provider-registered'])
    assert.equal(process.exitCode, 0)
    process.exitCode = originalProcessExitCode
    const recoveredRcContents = await readFile(rcPath, 'utf8')
    assert.include(recoveredRcContents, 'providers: applicationProviders()')
    assert.equal(
      recoveredRcContents.match(/import\("adonisjs-account-kit\/account_kit_provider"\)/g)?.length,
      1
    )
    assert.include(recoveredRcContents, 'const applicationProviders = () => [')
    assert.include(recoveredRcContents, 'providers: applicationConfig.providers')
    assert.equal(recoveredRcContents.match(/import\("application\/provider"\)/g)?.length, 1)
    assert.equal(
      recoveredRcContents.match(/import\('adonisjs-account-kit\/commands'\)/g)?.length,
      1
    )
    assert.equal(recoveredRcContents.match(/import\("application\/commands"\)/g)?.length, 1)
    assert.include(await readFile(configPath, 'utf8'), "from 'adonisjs-account-kit'")
    const migrationFilesAfterRecovery = await readdir(migrationsDirectory)
    assert.equal(
      migrationFilesAfterRecovery.filter((filename) => filename.endsWith('.ts')).length,
      migrationNames.length
    )
    const envAfterRecovery = await readFile(envPath, 'utf8')
    assert.equal(
      envAfterRecovery.match(/APP_URL: Env\.schema\.string\(\{ format: 'url', tld: false \}\)/g)
        ?.length,
      1
    )
    const recoveredMigrationFiles = migrationFilesAfterRecovery.sort()
    await recoveredConfigure
      .ace()
      .handle(['configure', 'adonisjs-account-kit', '--force', '--provider-registered'])
    const repeatedRcContents = await readFile(rcPath, 'utf8')
    assert.include(repeatedRcContents, 'const applicationProviders = () => [')
    assert.equal(
      repeatedRcContents.match(/import\("adonisjs-account-kit\/account_kit_provider"\)/g)?.length,
      1
    )
    assert.equal(repeatedRcContents.match(/import\('adonisjs-account-kit\/commands'\)/g)?.length, 1)
    assert.equal(repeatedRcContents.match(/import\("application\/commands"\)/g)?.length, 1)
    const repeatedMigrationFiles = await readdir(migrationsDirectory)
    assert.deepEqual(repeatedMigrationFiles.sort(), recoveredMigrationFiles)
    assert.equal(await readFile(envPath, 'utf8'), envAfterRecovery)

    const legacyDynamicRc = [
      "import { defineConfig } from '@adonisjs/core/app'",
      'const applicationProviders = () => [() => import("adonisjs-account-kit/providers/account_kit_provider"), () => import("application/provider")] as const',
      'const applicationConfig = { providers: applicationProviders(), commands: [() => import("application/commands")] }',
      'export default defineConfig({ ...applicationConfig, commands: [...(applicationConfig.commands ?? [])], providers: applicationConfig.providers })',
      '',
    ].join('\n')
    await writeFile(rcPath, legacyDynamicRc)
    await recoveredConfigure
      .ace()
      .handle(['configure', 'adonisjs-account-kit', '--force', '--provider-registered'])
    const recoveredLegacyRc = await readFile(rcPath, 'utf8')
    assert.include(recoveredLegacyRc, 'providers: applicationConfig.providers')
    assert.equal(
      recoveredLegacyRc.match(/import\("adonisjs-account-kit\/providers\/account_kit_provider"\)/g)
        ?.length,
      1
    )
    assert.equal(
      recoveredLegacyRc.match(/import\("adonisjs-account-kit\/account_kit_provider"\)/g)?.length ??
        0,
      0
    )
    assert.equal(recoveredLegacyRc.match(/import\("application\/provider"\)/g)?.length, 1)
    assert.equal(recoveredLegacyRc.match(/import\('adonisjs-account-kit\/commands'\)/g)?.length, 1)
    assert.equal(recoveredLegacyRc.match(/import\("application\/commands"\)/g)?.length, 1)
    const legacyMigrationFiles = await readdir(migrationsDirectory)
    assert.deepEqual(legacyMigrationFiles.sort(), recoveredMigrationFiles)
    assert.equal(await readFile(envPath, 'utf8'), envAfterRecovery)
  } finally {
    process.exitCode = originalProcessExitCode
    await rm(root, { recursive: true, force: true })
  }
}).timeout(30_000)

test('preserves inherited provider and command arrays with normalized spreads', async ({
  assert,
}) => {
  const project = await createConfigureProject()
  const { root, ignitorFor } = project
  const originalProcessExitCode = process.exitCode
  try {
    const rcPath = join(root, 'adonisrc.ts')
    await writeFile(
      rcPath,
      [
        "import { defineConfig } from '@adonisjs/core/app'",
        'const applicationConfig = { providers: [() => import("application/provider"), () => import("adonisjs-account-kit/account_kit_provider")], commands: [() => import("application/commands")] }',
        'export default defineConfig({ ...applicationConfig, providers: applicationConfig.providers, commands: [...(applicationConfig.commands ?? [])] })',
        '',
      ].join('\n')
    )

    await ignitorFor(root)
      .ace()
      .handle(['configure', 'adonisjs-account-kit', '--force', '--provider-registered'])

    assert.equal(process.exitCode, 0)
    process.exitCode = originalProcessExitCode
    const rcContents = await readFile(rcPath, 'utf8')
    assert.include(rcContents, 'providers: applicationConfig.providers')
    assert.include(rcContents, 'commands: [...(applicationConfig.commands ?? [])')
    assert.include(rcContents, '() => import("application/provider")')
    assert.include(rcContents, '() => import("application/commands")')
    assert.equal(rcContents.match(/import\('adonisjs-account-kit\/commands'\)/g)?.length, 1)
  } finally {
    process.exitCode = originalProcessExitCode
    await rm(root, { recursive: true, force: true })
  }
}).timeout(30_000)

test('rejects non-array command configs before writes even with provider assertion', async ({
  assert,
}) => {
  const commandProperties = [
    'commands: loadCommands()',
    'commands: applicationCommands',
    'commands',
  ]

  for (const commandProperty of commandProperties) {
    const project = await createConfigureProject()
    const { root, envPath, configDirectory, migrationsDirectory, ignitorFor } = project
    const originalProcessExitCode = process.exitCode
    try {
      const rcPath = join(root, 'adonisrc.ts')
      const source = [
        "import { defineConfig } from '@adonisjs/core/app'",
        'const applicationCommands = [() => import("application/commands")] as const',
        'const commands = applicationCommands',
        'function loadCommands() { return applicationCommands }',
        `export default defineConfig({ providers: [], ${commandProperty} })`,
        '',
      ].join('\n')
      await writeFile(rcPath, source)
      const envBefore = await readFile(envPath, 'utf8')

      await ignitorFor(root)
        .ace()
        .handle(['configure', 'adonisjs-account-kit', '--force', '--provider-registered'])

      assert.equal(process.exitCode, 1)
      process.exitCode = originalProcessExitCode
      assert.equal(await readFile(rcPath, 'utf8'), source)
      assert.deepEqual(await readdir(configDirectory), [])
      assert.deepEqual(await readdir(migrationsDirectory), [
        'custom_account_kit_create_password_reset_tokens.ts',
      ])
      assert.equal(await readFile(envPath, 'utf8'), envBefore)
    } finally {
      process.exitCode = originalProcessExitCode
      await rm(root, { recursive: true, force: true })
    }
  }
}).timeout(30_000)

test('rejects unsafe spread configs before writes even with provider assertion', async ({
  assert,
}) => {
  const unsafeConfigs = [
    'export default defineConfig({ ...applicationConfig })',
    'export default defineConfig({ providers: applicationConfig.providers, ...applicationConfig, commands: [] })',
    'export default defineConfig({ ...applicationConfig, providers: applicationConfig.providers })',
  ]

  for (const config of unsafeConfigs) {
    const project = await createConfigureProject()
    const { root, envPath, configDirectory, migrationsDirectory, ignitorFor } = project
    const originalProcessExitCode = process.exitCode
    try {
      const rcPath = join(root, 'adonisrc.ts')
      const source = [
        "import { defineConfig } from '@adonisjs/core/app'",
        'const applicationConfig = { providers: [() => import("application/provider")], commands: [() => import("application/commands")] }',
        config,
        '',
      ].join('\n')
      await writeFile(rcPath, source)
      const envBefore = await readFile(envPath, 'utf8')

      await ignitorFor(root)
        .ace()
        .handle(['configure', 'adonisjs-account-kit', '--force', '--provider-registered'])

      assert.equal(process.exitCode, 1)
      process.exitCode = originalProcessExitCode
      assert.equal(await readFile(rcPath, 'utf8'), source)
      assert.deepEqual(await readdir(configDirectory), [])
      assert.deepEqual(await readdir(migrationsDirectory), [
        'custom_account_kit_create_password_reset_tokens.ts',
      ])
      assert.equal(await readFile(envPath, 'utf8'), envBefore)
    } finally {
      process.exitCode = originalProcessExitCode
      await rm(root, { recursive: true, force: true })
    }
  }
}).timeout(30_000)

test('rejects computed and syntactically invalid configs before writes', async ({ assert }) => {
  const cases = [
    {
      declaration: "const field: string = 'providers'",
      config:
        'export default defineConfig({ providers: [() => import("application/provider")], commands: [], [field]: [() => import("application/override")] })',
      assertRegistered: true,
    },
    {
      declaration: "const field: string = 'commands'",
      config:
        'export default defineConfig({ providers: [() => import("application/provider")], commands: [], [field]: loadCommands() })',
      assertRegistered: true,
    },
    {
      declaration: "const field: string = 'file'",
      config:
        'export default defineConfig({ providers: [{ file: () => import("adonisjs-account-kit/providers/account_kit_provider"), [field]: () => import("application/provider") }], commands: [] })',
      assertRegistered: false,
    },
    {
      declaration: '',
      config: 'export default defineConfig({ providers: [], commands: [})',
      assertRegistered: true,
    },
  ]

  for (const { declaration, config, assertRegistered } of cases) {
    const project = await createConfigureProject()
    const { root, envPath, configDirectory, migrationsDirectory, ignitorFor } = project
    const originalProcessExitCode = process.exitCode
    try {
      const rcPath = join(root, 'adonisrc.ts')
      const source = [
        "import { defineConfig } from '@adonisjs/core/app'",
        declaration,
        'function loadCommands() { return [] }',
        config,
        '',
      ].join('\n')
      await writeFile(rcPath, source)
      const envBefore = await readFile(envPath, 'utf8')
      const args = ['configure', 'adonisjs-account-kit', '--force']
      if (assertRegistered) args.push('--provider-registered')

      await ignitorFor(root).ace().handle(args)

      assert.equal(process.exitCode, 1)
      process.exitCode = originalProcessExitCode
      assert.equal(await readFile(rcPath, 'utf8'), source)
      assert.deepEqual(await readdir(configDirectory), [])
      assert.deepEqual(await readdir(migrationsDirectory), [
        'custom_account_kit_create_password_reset_tokens.ts',
      ])
      assert.equal(await readFile(envPath, 'utf8'), envBefore)
    } finally {
      process.exitCode = originalProcessExitCode
      await rm(root, { recursive: true, force: true })
    }
  }
}).timeout(30_000)

test('checks effective provider object file entries around spreads', async ({ assert }) => {
  const project = await createConfigureProject()
  const { root, configDirectory, migrationsDirectory, ignitorFor } = project
  const originalProcessExitCode = process.exitCode
  try {
    const rcPath = join(root, 'adonisrc.ts')
    const unsafeSource = [
      "import { defineConfig } from '@adonisjs/core/app'",
      'const providerOverride = { file: () => import("application/provider") }',
      'export default defineConfig({ providers: [{ file: () => import("adonisjs-account-kit/providers/account_kit_provider"), ...providerOverride }], commands: [] })',
      '',
    ].join('\n')
    await writeFile(rcPath, unsafeSource)

    await ignitorFor(root).ace().handle(['configure', 'adonisjs-account-kit', '--force'])

    assert.equal(process.exitCode, 1)
    process.exitCode = originalProcessExitCode
    assert.equal(await readFile(rcPath, 'utf8'), unsafeSource)
    assert.deepEqual(await readdir(configDirectory), [])
    assert.deepEqual(await readdir(migrationsDirectory), [
      'custom_account_kit_create_password_reset_tokens.ts',
    ])

    const safeSource = [
      "import { defineConfig } from '@adonisjs/core/app'",
      'const providerOptions = { environment: ["console"] }',
      'export default defineConfig({ providers: [{ ...providerOptions, file: () => import("adonisjs-account-kit/providers/account_kit_provider") }, () => import("application/provider")], commands: [] })',
      '',
    ].join('\n')
    await writeFile(rcPath, safeSource)
    await ignitorFor(root).ace().handle(['configure', 'adonisjs-account-kit', '--force'])

    assert.equal(process.exitCode, 0)
    process.exitCode = originalProcessExitCode
    const rcContents = await readFile(rcPath, 'utf8')
    assert.include(
      rcContents,
      '...providerOptions, file: () => import("adonisjs-account-kit/providers/account_kit_provider")'
    )
    assert.include(rcContents, '() => import("application/provider")')
    assert.equal(
      rcContents.match(/import\("adonisjs-account-kit\/providers\/account_kit_provider"\)/g)
        ?.length,
      1
    )
    assert.equal(
      rcContents.match(/import\("adonisjs-account-kit\/account_kit_provider"\)/g)?.length ?? 0,
      0
    )
    assert.equal(rcContents.match(/import\('adonisjs-account-kit\/commands'\)/g)?.length, 1)
  } finally {
    process.exitCode = originalProcessExitCode
    await rm(root, { recursive: true, force: true })
  }
}).timeout(30_000)

function fakeCommand(
  root: string,
  parsedFlags: Record<string, unknown>,
  rcContents?: string,
  projectUnavailable = false
) {
  const calls = {
    migrations: [] as Array<Record<string, unknown>>,
    stubs: [] as string[],
    envValidations: 0,
    errors: [] as string[],
    providers: [] as string[],
    infos: [] as string[],
  }
  const codemods = {
    overwriteExisting: true,
    async getTsMorphProject() {
      if (projectUnavailable) return undefined
      await writeFile(join(root, 'tsconfig.json'), '{}')
      const project = new CodeTransformer(pathToFileURL(`${root}/`)).project
      project.createSourceFile(
        join(root, 'adonisrc.ts'),
        rcContents ??
          "import { defineConfig } from '@adonisjs/core/app'\nexport default defineConfig({ providers: [] })"
      )
      return project
    },
    async makeUsingStub(_root: string, name: string, data: Record<string, unknown>) {
      calls.stubs.push(name)
      if (name.startsWith('migrations/'))
        calls.migrations.push(data.migration as Record<string, unknown>)
    },
    async updateRcFile(
      update: (rcFile: { addProvider(name: string): void; addCommand(name: string): void }) => void
    ) {
      update({
        addProvider(name) {
          calls.providers.push(name)
        },
        addCommand() {},
      })
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
      info(message: string) {
        calls.infos.push(message)
      },
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

test('configure registers the root provider export and keeps a registered legacy path', async ({
  assert,
}) => {
  const root = await mkdtemp(join(tmpdir(), 'account-kit-provider-path-'))
  try {
    await mkdir(join(root, 'database', 'migrations'), { recursive: true })
    const fresh = fakeCommand(root, {})
    await configure(fresh.command as unknown as Configure)
    assert.deepEqual(fresh.calls.errors, [])
    assert.deepEqual(fresh.calls.providers, ['adonisjs-account-kit/account_kit_provider'])

    const existing = fakeCommand(
      root,
      {},
      "import { defineConfig } from '@adonisjs/core/app'\nexport default defineConfig({ providers: [() => import('adonisjs-account-kit/providers/account_kit_provider')] })\n"
    )
    await configure(existing.command as unknown as Configure)
    assert.deepEqual(existing.calls.providers, [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('configure rejects unavailable projects before generating files', async ({ assert }) => {
  const root = await mkdtemp(join(tmpdir(), 'account-kit-provider-preflight-'))
  try {
    for (const flags of [{}, { 'provider-registered': true }]) {
      const { command, calls } = fakeCommand(root, flags, undefined, true)
      await configure(command as unknown as Configure)
      assert.equal(command.exitCode, 1)
      assert.lengthOf(calls.errors, 1)
      assert.deepEqual(calls.stubs, [])
      assert.deepEqual(calls.migrations, [])
      assert.equal(calls.envValidations, 0)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('configure names a missing defineConfig call before generating files', async ({ assert }) => {
  const root = await mkdtemp(join(tmpdir(), 'account-kit-missing-define-config-'))
  try {
    const { command, calls } = fakeCommand(root, {}, 'export default { providers: [] }')
    await configure(command as unknown as Configure)
    assert.equal(command.exitCode, 1)
    assert.lengthOf(calls.errors, 1)
    assert.include(calls.errors[0], 'could not locate the defineConfig call')
    assert.deepEqual(calls.stubs, [])
    assert.equal(calls.envValidations, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('configure requires an explicit registration assertion for dynamic providers', async ({
  assert,
}) => {
  const root = await mkdtemp(join(tmpdir(), 'account-kit-dynamic-provider-'))
  try {
    await mkdir(join(root, 'database', 'migrations'), { recursive: true })
    const dynamicRc =
      "import { defineConfig } from '@adonisjs/core/app'\nconst applicationProviders = () => [...baseProviders]\nexport default defineConfig({ providers: applicationProviders() })"
    const dynamicConfigRc =
      "import { defineConfig } from '@adonisjs/core/app'\nconst appConfig = { providers: [...baseProviders] }\nexport default defineConfig(appConfig)"
    const normalizedDynamicConfigRc =
      "import { defineConfig } from '@adonisjs/core/app'\nconst appConfig = { providers: [...baseProviders], commands: [() => import('application/commands')] }\nexport default defineConfig({ ...appConfig, commands: [...(appConfig.commands ?? [])], providers: appConfig.providers })"
    const legacyDynamicRc =
      "import { defineConfig } from '@adonisjs/core/app'\nconst applicationProviders = () => [() => import('adonisjs-account-kit/providers/account_kit_provider'), ...baseProviders]\nexport default defineConfig({ providers: applicationProviders() })"
    const unsupportedProviderEntryRc =
      "import { defineConfig } from '@adonisjs/core/app'\nexport default defineConfig({ providers: [registerProvider()], commands: [] })"
    const unsupportedProviderObjectRc =
      "import { defineConfig } from '@adonisjs/core/app'\nexport default defineConfig({ providers: [{ file: loadProvider }], commands: [] })"

    for (const [flags, source] of [
      [{}, dynamicRc],
      [{ 'provider-registered': false }, dynamicRc],
      [{ 'provider-registered': 'true' }, dynamicRc],
      [{}, dynamicConfigRc],
      [{ 'provider-registered': false }, dynamicConfigRc],
      [{}, unsupportedProviderEntryRc],
      [{}, unsupportedProviderObjectRc],
    ] as const) {
      const { command, calls } = fakeCommand(root, flags, source)
      await configure(command as unknown as Configure)
      assert.equal(command.exitCode, 1)
      assert.lengthOf(calls.errors, 1)
      assert.include(calls.errors[0], 'adonisjs-account-kit/account_kit_provider')
      assert.include(calls.errors[0], 'adonisjs-account-kit/providers/account_kit_provider')
      assert.include(calls.errors[0], 'exactly once')
      assert.include(
        calls.errors[0],
        'node ace configure adonisjs-account-kit --provider-registered'
      )
      assert.deepEqual(calls.stubs, [])
      assert.deepEqual(calls.migrations, [])
      assert.equal(calls.envValidations, 0)
    }

    const unnormalized = fakeCommand(root, { 'provider-registered': true }, dynamicConfigRc)
    await configure(unnormalized.command as unknown as Configure)
    assert.equal(unnormalized.command.exitCode, 1)
    assert.include(unnormalized.calls.errors[0], 'Pass the config as an object literal')
    assert.include(
      unnormalized.calls.errors[0],
      'commands: [...(applicationConfig.commands ?? [])]'
    )
    assert.deepEqual(unnormalized.calls.stubs, [])
    assert.deepEqual(unnormalized.calls.migrations, [])
    assert.equal(unnormalized.calls.envValidations, 0)

    const recovered = fakeCommand(root, { 'provider-registered': true }, normalizedDynamicConfigRc)
    await configure(recovered.command as unknown as Configure)
    assert.isUndefined(recovered.command.exitCode)
    assert.deepEqual(recovered.calls.errors, [])
    assert.deepEqual(recovered.calls.providers, [])
    assert.lengthOf(recovered.calls.migrations, migrationNames.length)
    assert.equal(recovered.calls.envValidations, 1)
    assert.deepEqual(recovered.calls.infos, [
      'Assuming adonisrc.ts already registers the Account Kit provider; provider registration will not be changed.',
    ])

    const existingLegacy = fakeCommand(root, { 'provider-registered': true }, legacyDynamicRc)
    await configure(existingLegacy.command as unknown as Configure)
    assert.isUndefined(existingLegacy.command.exitCode)
    assert.deepEqual(existingLegacy.calls.errors, [])
    assert.deepEqual(existingLegacy.calls.providers, [])
    assert.lengthOf(existingLegacy.calls.migrations, migrationNames.length)
    assert.deepEqual(existingLegacy.calls.infos, [
      'Assuming adonisrc.ts already registers the Account Kit provider; provider registration will not be changed.',
    ])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}).timeout(30_000)

test('migrationSchema reports invalid schema flags with RuntimeException', ({ assert }) => {
  assert.throws(() => migrationSchema('bad-name'), RuntimeException)
  assert.throws(() => migrationSchema('users', 'bigint' as never), RuntimeException)
})
