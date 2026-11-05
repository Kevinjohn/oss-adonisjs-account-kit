import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test } from '@japa/runner'
import { ListLoader } from '@adonisjs/core/ace'
import Configure from '@adonisjs/core/commands/configure'
import { IgnitorFactory } from '@adonisjs/core/factories'
import { migrationNames } from '../configure.js'

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
    specifier === '@kevinjohn/adonisjs-account-kit' ? import(packageEntry) : import(specifier)
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

    await ignitor.ace().handle(['configure', '@kevinjohn/adonisjs-account-kit', '--force'])
    const generatedConfig = await readFile(configPath, 'utf8')
    assert.include(generatedConfig, "from '@kevinjohn/adonisjs-account-kit'")
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
      firstRcContents.match(
        new RegExp(String.raw`@kevinjohn/adonisjs-account-kit\/account_kit_provider`, 'g')
      )?.length,
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
    await ignitor.ace().handle(['configure', '@kevinjohn/adonisjs-account-kit', '--force'])

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
      secondRcContents.match(
        new RegExp(String.raw`@kevinjohn/adonisjs-account-kit\/account_kit_provider`, 'g')
      )?.length,
      1
    )

    await writeFile(
      rcPath,
      [
        "import { defineConfig as makeConfig } from '@adonisjs/core/app'",
        'const defineConfig = makeConfig',
        "// '@kevinjohn/adonisjs-account-kit/account_kit_provider'",
        "/* '@kevinjohn/adonisjs-account-kit/account_kit_provider' */",
        "const note = '@kevinjohn/adonisjs-account-kit/account_kit_provider'",
        'const template = `@kevinjohn/adonisjs-account-kit/account_kit_provider`',
        "export default defineConfig({ note, template, providers: [() => import('@kevinjohn/adonisjs-account-kit/account_kit_provider_extra')] })",
        '',
      ].join('\n')
    )
    await ignitor.ace().handle(['configure', '@kevinjohn/adonisjs-account-kit', '--force'])
    let rcContents = await readFile(rcPath, 'utf8')
    assert.equal(
      rcContents.match(
        new RegExp(
          String.raw`import\('@kevinjohn/adonisjs-account-kit\/account_kit_provider'\)`,
          'g'
        )
      )?.length,
      1
    )
    assert.include(
      rcContents,
      "import('@kevinjohn/adonisjs-account-kit/account_kit_provider_extra')"
    )

    await writeFile(
      rcPath,
      [
        "import { defineConfig } from '@adonisjs/core/app'",
        "export default defineConfig({ providers: [{ file: () => import('@kevinjohn/adonisjs-account-kit/account_kit_provider'), environment: ['console'] }] })",
        '',
      ].join('\n')
    )
    await ignitor.ace().handle(['configure', '@kevinjohn/adonisjs-account-kit', '--force'])
    rcContents = await readFile(rcPath, 'utf8')
    assert.equal(
      rcContents.match(
        new RegExp(
          String.raw`import\('@kevinjohn/adonisjs-account-kit\/account_kit_provider'\)`,
          'g'
        )
      )?.length,
      1
    )

    await writeFile(
      rcPath,
      [
        "import { defineConfig } from '@adonisjs/core/app'",
        "export default defineConfig({ providers: [{ file: () => { return import('@kevinjohn/adonisjs-account-kit/account_kit_provider') }, environment: ['console'] }] })",
        '',
      ].join('\n')
    )
    await ignitor.ace().handle(['configure', '@kevinjohn/adonisjs-account-kit', '--force'])
    rcContents = await readFile(rcPath, 'utf8')
    assert.equal(
      rcContents.match(
        new RegExp(
          String.raw`import\('@kevinjohn/adonisjs-account-kit\/account_kit_provider'\)`,
          'g'
        )
      )?.length,
      1
    )

    await writeFile(
      rcPath,
      "import { defineConfig } from '@adonisjs/core/app'\nexport default defineConfig({ providers: [() => import('@kevinjohn/adonisjs-account-kit/account_kit_provider')] })\n"
    )
    await ignitor.ace().handle(['configure', '@kevinjohn/adonisjs-account-kit', '--force'])
    rcContents = await readFile(rcPath, 'utf8')
    assert.equal(
      rcContents.match(
        new RegExp(
          String.raw`import\('@kevinjohn/adonisjs-account-kit\/account_kit_provider'\)`,
          'g'
        )
      )?.length,
      1
    )

    await writeFile(
      rcPath,
      "import { defineConfig } from '@adonisjs/core/app'\nexport default defineConfig({})\n"
    )
    await ignitor.ace().handle(['configure', '@kevinjohn/adonisjs-account-kit', '--force'])
    rcContents = await readFile(rcPath, 'utf8')
    assert.equal(
      rcContents.match(
        new RegExp(
          String.raw`import\('@kevinjohn/adonisjs-account-kit\/account_kit_provider'\)`,
          'g'
        )
      )?.length,
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
    await failedConfigure.ace().handle(['configure', '@kevinjohn/adonisjs-account-kit', '--force'])
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
      'const applicationProviders = () => [() => import("application/provider"), () => import("@kevinjohn/adonisjs-account-kit/account_kit_provider")] as const',
      'const applicationConfig = { providers: applicationProviders(), commands: [() => import("application/commands")] }',
      'export default defineConfig({ ...applicationConfig, commands: [...(applicationConfig.commands ?? [])], providers: applicationConfig.providers })',
      '',
    ].join('\n')
    await writeFile(rcPath, dynamicRcWithAccountKit)
    const recoveredConfigure = ignitorFor(root)
    await recoveredConfigure
      .ace()
      .handle(['configure', '@kevinjohn/adonisjs-account-kit', '--force', '--provider-registered'])
    assert.equal(process.exitCode, 0)
    process.exitCode = originalProcessExitCode
    const recoveredRcContents = await readFile(rcPath, 'utf8')
    assert.include(recoveredRcContents, 'providers: applicationProviders()')
    assert.equal(
      recoveredRcContents.match(
        new RegExp(
          String.raw`import\("@kevinjohn/adonisjs-account-kit\/account_kit_provider"\)`,
          'g'
        )
      )?.length,
      1
    )
    assert.include(recoveredRcContents, 'const applicationProviders = () => [')
    assert.include(recoveredRcContents, 'providers: applicationConfig.providers')
    assert.equal(recoveredRcContents.match(/import\("application\/provider"\)/g)?.length, 1)
    assert.equal(
      recoveredRcContents.match(
        new RegExp(String.raw`import\('@kevinjohn/adonisjs-account-kit\/commands'\)`, 'g')
      )?.length,
      1
    )
    assert.equal(recoveredRcContents.match(/import\("application\/commands"\)/g)?.length, 1)
    assert.include(await readFile(configPath, 'utf8'), "from '@kevinjohn/adonisjs-account-kit'")
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
      .handle(['configure', '@kevinjohn/adonisjs-account-kit', '--force', '--provider-registered'])
    const repeatedRcContents = await readFile(rcPath, 'utf8')
    assert.include(repeatedRcContents, 'const applicationProviders = () => [')
    assert.equal(
      repeatedRcContents.match(
        new RegExp(
          String.raw`import\("@kevinjohn/adonisjs-account-kit\/account_kit_provider"\)`,
          'g'
        )
      )?.length,
      1
    )
    assert.equal(
      repeatedRcContents.match(
        new RegExp(String.raw`import\('@kevinjohn/adonisjs-account-kit\/commands'\)`, 'g')
      )?.length,
      1
    )
    assert.equal(repeatedRcContents.match(/import\("application\/commands"\)/g)?.length, 1)
    const repeatedMigrationFiles = await readdir(migrationsDirectory)
    assert.deepEqual(repeatedMigrationFiles.sort(), recoveredMigrationFiles)
    assert.equal(await readFile(envPath, 'utf8'), envAfterRecovery)

    const registeredDynamicRc = [
      "import { defineConfig } from '@adonisjs/core/app'",
      'const applicationProviders = () => [() => import("@kevinjohn/adonisjs-account-kit/account_kit_provider"), () => import("application/provider")] as const',
      'const applicationConfig = { providers: applicationProviders(), commands: [() => import("application/commands")] }',
      'export default defineConfig({ ...applicationConfig, commands: [...(applicationConfig.commands ?? [])], providers: applicationConfig.providers })',
      '',
    ].join('\n')
    await writeFile(rcPath, registeredDynamicRc)
    await recoveredConfigure
      .ace()
      .handle(['configure', '@kevinjohn/adonisjs-account-kit', '--force', '--provider-registered'])
    const recoveredRegisteredRc = await readFile(rcPath, 'utf8')
    assert.include(recoveredRegisteredRc, 'providers: applicationConfig.providers')
    assert.equal(
      recoveredRegisteredRc.match(
        new RegExp(
          String.raw`import\("@kevinjohn/adonisjs-account-kit\/account_kit_provider"\)`,
          'g'
        )
      )?.length,
      1
    )
    assert.equal(recoveredRegisteredRc.match(/import\("application\/provider"\)/g)?.length, 1)
    assert.equal(
      recoveredRegisteredRc.match(
        new RegExp(String.raw`import\('@kevinjohn/adonisjs-account-kit\/commands'\)`, 'g')
      )?.length,
      1
    )
    assert.equal(recoveredRegisteredRc.match(/import\("application\/commands"\)/g)?.length, 1)
    const registeredMigrationFiles = await readdir(migrationsDirectory)
    assert.deepEqual(registeredMigrationFiles.sort(), recoveredMigrationFiles)
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
        'const applicationConfig = { providers: [() => import("application/provider"), () => import("@kevinjohn/adonisjs-account-kit/account_kit_provider")], commands: [() => import("application/commands")] }',
        'export default defineConfig({ ...applicationConfig, providers: applicationConfig.providers, commands: [...(applicationConfig.commands ?? [])] })',
        '',
      ].join('\n')
    )

    await ignitorFor(root)
      .ace()
      .handle(['configure', '@kevinjohn/adonisjs-account-kit', '--force', '--provider-registered'])

    assert.equal(process.exitCode, 0)
    process.exitCode = originalProcessExitCode
    const rcContents = await readFile(rcPath, 'utf8')
    assert.include(rcContents, 'providers: applicationConfig.providers')
    assert.include(rcContents, 'commands: [...(applicationConfig.commands ?? [])')
    assert.include(rcContents, '() => import("application/provider")')
    assert.include(rcContents, '() => import("application/commands")')
    assert.equal(
      rcContents.match(
        new RegExp(String.raw`import\('@kevinjohn/adonisjs-account-kit\/commands'\)`, 'g')
      )?.length,
      1
    )
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
        .handle([
          'configure',
          '@kevinjohn/adonisjs-account-kit',
          '--force',
          '--provider-registered',
        ])

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
        .handle([
          'configure',
          '@kevinjohn/adonisjs-account-kit',
          '--force',
          '--provider-registered',
        ])

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
        'export default defineConfig({ providers: [{ file: () => import("@kevinjohn/adonisjs-account-kit/account_kit_provider"), [field]: () => import("application/provider") }], commands: [] })',
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
      const args = ['configure', '@kevinjohn/adonisjs-account-kit', '--force']
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
      'export default defineConfig({ providers: [{ file: () => import("@kevinjohn/adonisjs-account-kit/account_kit_provider"), ...providerOverride }], commands: [] })',
      '',
    ].join('\n')
    await writeFile(rcPath, unsafeSource)

    await ignitorFor(root).ace().handle(['configure', '@kevinjohn/adonisjs-account-kit', '--force'])

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
      'export default defineConfig({ providers: [{ ...providerOptions, file: () => import("@kevinjohn/adonisjs-account-kit/account_kit_provider") }, () => import("application/provider")], commands: [] })',
      '',
    ].join('\n')
    await writeFile(rcPath, safeSource)
    await ignitorFor(root).ace().handle(['configure', '@kevinjohn/adonisjs-account-kit', '--force'])

    assert.equal(process.exitCode, 0)
    process.exitCode = originalProcessExitCode
    const rcContents = await readFile(rcPath, 'utf8')
    assert.include(
      rcContents,
      '...providerOptions, file: () => import("@kevinjohn/adonisjs-account-kit/account_kit_provider")'
    )
    assert.include(rcContents, '() => import("application/provider")')
    assert.equal(
      rcContents.match(
        new RegExp(
          String.raw`import\("@kevinjohn/adonisjs-account-kit\/account_kit_provider"\)`,
          'g'
        )
      )?.length,
      1
    )
    assert.equal(
      rcContents.match(
        new RegExp(String.raw`import\('@kevinjohn/adonisjs-account-kit\/commands'\)`, 'g')
      )?.length,
      1
    )
  } finally {
    process.exitCode = originalProcessExitCode
    await rm(root, { recursive: true, force: true })
  }
}).timeout(30_000)
