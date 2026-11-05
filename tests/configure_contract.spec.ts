import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test } from '@japa/runner'
import type Configure from '@adonisjs/core/commands/configure'
import { RuntimeException } from '@adonisjs/core/exceptions'
import { CodeTransformer } from '@adonisjs/assembler/code_transformer'
import { configure, migrationNames, migrationSchema } from '../configure.js'

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

test('configure registers the root provider export once', async ({ assert }) => {
  const root = await mkdtemp(join(tmpdir(), 'account-kit-provider-path-'))
  try {
    await mkdir(join(root, 'database', 'migrations'), { recursive: true })
    const fresh = fakeCommand(root, {})
    await configure(fresh.command as unknown as Configure)
    assert.deepEqual(fresh.calls.errors, [])
    assert.deepEqual(fresh.calls.providers, [
      '@kevinjohn/adonisjs-account-kit/account_kit_provider',
    ])

    const existing = fakeCommand(
      root,
      {},
      "import { defineConfig } from '@adonisjs/core/app'\nexport default defineConfig({ providers: [() => import('@kevinjohn/adonisjs-account-kit/account_kit_provider')] })\n"
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
    const registeredDynamicRc =
      "import { defineConfig } from '@adonisjs/core/app'\nconst applicationProviders = () => [() => import('@kevinjohn/adonisjs-account-kit/account_kit_provider'), ...baseProviders]\nexport default defineConfig({ providers: applicationProviders() })"
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
      assert.include(calls.errors[0], '@kevinjohn/adonisjs-account-kit/account_kit_provider')
      assert.include(calls.errors[0], 'exactly once')
      assert.include(
        calls.errors[0],
        'node ace configure @kevinjohn/adonisjs-account-kit --provider-registered'
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

    const existingRegistered = fakeCommand(
      root,
      { 'provider-registered': true },
      registeredDynamicRc
    )
    await configure(existingRegistered.command as unknown as Configure)
    assert.isUndefined(existingRegistered.command.exitCode)
    assert.deepEqual(existingRegistered.calls.errors, [])
    assert.deepEqual(existingRegistered.calls.providers, [])
    assert.lengthOf(existingRegistered.calls.migrations, migrationNames.length)
    assert.deepEqual(existingRegistered.calls.infos, [
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
