/* eslint-disable @unicorn/no-await-expression-member -- Keep each assertion next to the operation it inspects. */

import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test } from '@japa/runner'
import { ListLoader } from '@adonisjs/core/ace'
import { IgnitorFactory } from '@adonisjs/core/factories'
import InstallAdmission from '../commands/admission_install.js'

// Each test runs a full ace command; V8 coverage instrumentation roughly triples its time.
const commandTimeout = process.env.NODE_V8_COVERAGE ? 30_000 : 10_000

test.group('admission install command', () => {
  async function fixture() {
    const root = await mkdtemp(join(tmpdir(), 'account-kit-admission-install-'))
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
    await mkdir(join(root, 'config'), { recursive: true })
    await mkdir(join(root, 'database', 'migrations'), { recursive: true })
    const ignitor = new IgnitorFactory()
      .withCoreProviders()
      .withCoreConfig()
      .merge({
        rcFileContents: {
          providers: [],
          commands: [async () => new ListLoader([InstallAdmission])],
        },
      })
      .create(pathToFileURL(`${root}/`))
    const run = async (...args: string[]) => {
      await ignitor.ace().handle(['account-kit:admission:install', ...args])
    }
    return { root, run }
  }

  test('renders the migration for the chosen table and id type and registers the module', async ({
    assert,
  }) => {
    const { root, run } = await fixture()
    try {
      const printed: string[] = []
      const log = console.log
      console.log = (...parts: unknown[]) => printed.push(parts.join(' '))
      try {
        await run('--users-table=members', '--user-id-type=uuid')
      } finally {
        console.log = log
      }
      assert.isTrue(printed.some((line) => line.includes('node ace migration:run')))
      const migrations = await readdir(join(root, 'database', 'migrations'))
      assert.lengthOf(migrations, 1)
      assert.match(migrations[0], /^\d+_account_kit_admission_create_account_admissions\.ts$/)
      const migration = await readFile(join(root, 'database', 'migrations', migrations[0]), 'utf8')
      assert.include(migration, "table.uuid('user_id').nullable().unique()")
      assert.include(migration, "table.string('bootstrap_email', 254).nullable().unique()")
      assert.include(migration, "table.uuid('approval_actor_id').nullable()")
      assert.equal(migration.match(/inTable\("members"\)/g)?.length, 2)
      assert.notInclude(migration, '{{')

      const config = await readFile(join(root, 'config', 'admission.ts'), 'utf8')
      assert.include(config, "from 'adonisjs-account-kit/admission'")
      assert.include(config, 'defineAdmission(')
      const rc = await readFile(join(root, 'adonisrc.ts'), 'utf8')
      assert.include(rc, 'adonisjs-account-kit/admission/provider')
      assert.include(rc, 'adonisjs-account-kit/admission/commands')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }).timeout(commandTimeout)

  test('never overwrites the config or adds a second migration', async ({ assert }) => {
    const { root, run } = await fixture()
    try {
      await run()
      const ownConfig = 'export default { owner: true }\n'
      await writeFile(join(root, 'config', 'admission.ts'), ownConfig)
      await run()
      assert.equal(await readFile(join(root, 'config', 'admission.ts'), 'utf8'), ownConfig)
      assert.lengthOf(await readdir(join(root, 'database', 'migrations')), 1)
      const migration = (await readdir(join(root, 'database', 'migrations')))[0]
      const contents = await readFile(join(root, 'database', 'migrations', migration), 'utf8')
      assert.include(contents, "table.integer('user_id').unsigned()")
      const rc = await readFile(join(root, 'adonisrc.ts'), 'utf8')
      assert.equal(rc.match(/adonisjs-account-kit\/admission\/provider/g)?.length, 1)
      assert.equal(rc.match(/adonisjs-account-kit\/admission\/commands/g)?.length, 1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }).timeout(commandTimeout)

  test('refuses an unsupported id type without writing', async ({ assert }) => {
    const { root, run } = await fixture()
    try {
      // Ace reports the failure through the process exit code; keep the test run's own.
      const previousExitCode = process.exitCode
      await run('--user-id-type=bigint')
      assert.equal(process.exitCode, 1)
      process.exitCode = previousExitCode
      assert.lengthOf(await readdir(join(root, 'database', 'migrations')), 0)
      await assert.rejects(() => readFile(join(root, 'config', 'admission.ts'), 'utf8'))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }).timeout(commandTimeout)
})
