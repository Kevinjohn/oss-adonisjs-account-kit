import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test } from '@japa/runner'
import { ListLoader } from '@adonisjs/core/ace'
import { IgnitorFactory } from '@adonisjs/core/factories'
import { MigrationRunner } from '@adonisjs/lucid/migration'
import InstallAdmission from '../commands/admission_install.ts'

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
      assert.include(config, "from '@kevinjohn/adonisjs-account-kit/admission'")
      assert.include(config, 'defineConfig(')
      const rc = await readFile(join(root, 'adonisrc.ts'), 'utf8')
      assert.include(rc, '@kevinjohn/adonisjs-account-kit/admission/provider')
      assert.include(rc, '@kevinjohn/adonisjs-account-kit/admission/commands')
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
      // eslint-disable-next-line @unicorn/no-await-expression-member -- Assert the result at the call site.
      const migration = (await readdir(join(root, 'database', 'migrations')))[0]
      const contents = await readFile(join(root, 'database', 'migrations', migration), 'utf8')
      assert.include(contents, "table.integer('user_id').unsigned()")
      const rc = await readFile(join(root, 'adonisrc.ts'), 'utf8')
      assert.equal(
        rc.match(new RegExp(String.raw`@kevinjohn/adonisjs-account-kit\/admission\/provider`, 'g'))
          ?.length,
        1
      )
      assert.equal(
        rc.match(new RegExp(String.raw`@kevinjohn/adonisjs-account-kit\/admission\/commands`, 'g'))
          ?.length,
        1
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }).timeout(commandTimeout)

  test('installs after users in the primary Lucid path, runs with foreign keys, and preserves the migration on rerun', async ({
    assert,
  }) => {
    const { root, run } = await fixture()
    const directory = join(root, 'db/company/prior#review')
    const configPath = join(root, 'config/database.ts')
    const users = '9999999999000_create_users.ts'
    const admission = '9999999999001_account_kit_admission_create_account_admissions.ts'
    try {
      await mkdir(directory, { recursive: true })
      await writeFile(
        configPath,
        `import { defineConfig } from '@adonisjs/lucid'
export default defineConfig({ connection: 'company', connections: {
  other: { client: 'better-sqlite3', connection: { filename: ':memory:' } },
  company: { client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true,
    migrations: { paths: ['db/company'] } }
} })`
      )
      await writeFile(
        join(directory, users),
        `import { BaseSchema } from '@adonisjs/lucid/schema'
export default class extends BaseSchema {
  async up() { this.schema.createTable('users', (table) => table.increments('id')) }
}`
      )
      await run()
      // eslint-disable-next-line @unicorn/no-await-expression-member -- Assert the result at the call site.
      assert.deepEqual((await readdir(directory)).sort(), [users, admission])
      assert.deepEqual(await readdir(join(root, 'db/company')), ['prior#review'])
      assert.deepEqual(await readdir(join(root, 'database/migrations')), [])
      const migration = await readFile(join(directory, admission), 'utf8')
      await run()
      // eslint-disable-next-line @unicorn/no-await-expression-member -- Assert the result at the call site.
      assert.deepEqual((await readdir(directory)).sort(), [users, admission])
      assert.equal(await readFile(join(directory, admission), 'utf8'), migration)

      const { default: database } = await import(pathToFileURL(configPath).href)
      const app = new IgnitorFactory()
        .withCoreProviders()
        .withCoreConfig()
        .merge({
          rcFileContents: { providers: [() => import('@adonisjs/lucid/database_provider')] },
          config: { database },
        })
        .create(pathToFileURL(`${root}/`))
        .createApp('console')
      await app.init()
      await app.boot()
      const db = await app.container.make('lucid.db')
      try {
        await db.rawQuery('PRAGMA foreign_keys = ON').exec()
        const runner = new MigrationRunner(db, app, { direction: 'up' })
        await runner.run()
        if (runner.error) throw runner.error
        const rows = await db.from('adonis_schema').select('name').orderBy('id')
        assert.deepEqual(
          rows.map(({ name }) => name),
          [users, admission].map((file) => `db/company/prior#review/${file.slice(0, -3)}`)
        )
        const dates = { created_at: '2026-11-22', updated_at: '2026-11-22' }
        await assert.rejects(
          () => db.table('account_admissions').insert({ ...dates, user_id: 1 }),
          /FOREIGN KEY constraint failed/
        )
        await db.table('users').insert({ id: 1 })
        await db.table('account_admissions').insert({ ...dates, user_id: 1 })
        // eslint-disable-next-line @unicorn/no-await-expression-member -- Assert the result at the call site.
        assert.equal((await db.from('account_admissions').first()).user_id, 1)
      } finally {
        await app.terminate()
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }).timeout(commandTimeout)

  test('installs into the configured path named by --migration-directory and otherwise writes nothing', async ({
    assert,
  }) => {
    const { root, run } = await fixture()
    const previousExitCode = process.exitCode
    const errors: string[] = []
    const logError = console.error
    try {
      await mkdir(join(root, 'database/tenant'))
      await writeFile(
        join(root, 'config/database.ts'),
        "import { defineConfig } from '@adonisjs/lucid'\nexport default defineConfig({ connection: 'sqlite', connections: { sqlite: { client: 'better-sqlite3', migrations: { paths: ['database/migrations', 'database/tenant'] } } } })"
      )
      console.error = (...parts: unknown[]) => errors.push(parts.join(' '))
      await run()
      console.error = logError
      assert.equal(process.exitCode, 1)
      assert.isTrue(
        errors.some(
          (line) => line.includes('several migration paths') && line.includes('Nothing was written')
        )
      )
      await assert.rejects(() => readFile(join(root, 'config', 'admission.ts'), 'utf8'))

      process.exitCode = undefined
      await run('--migration-directory=database/tenant')
      assert.equal(process.exitCode, 0)
      assert.lengthOf(await readdir(join(root, 'database/tenant')), 1)
      assert.lengthOf(await readdir(join(root, 'database/migrations')), 0)
    } finally {
      console.error = logError
      process.exitCode = previousExitCode
      await rm(root, { recursive: true, force: true })
    }
  }).timeout(commandTimeout)

  test('installs into the --migration-directory named for a dynamic Lucid path', async ({
    assert,
  }) => {
    const { root, run } = await fixture()
    const previousExitCode = process.exitCode
    try {
      await writeFile(
        join(root, 'config/database.ts'),
        "import { defineConfig } from '@adonisjs/lucid'\nimport env from '#start/env'\nconst paths = ['database/custom']\nexport default defineConfig({ connection: env.get('DB_CONNECTION'), connections: { sqlite: { client: 'better-sqlite3', migrations: { paths } } } })"
      )
      await mkdir(join(root, 'deployment'))
      await writeFile(join(root, 'deployment', '.env.production'), 'DB_CONNECTION=sqlite\n')
      process.exitCode = undefined
      await run(
        '--env=NODE_ENV=production',
        '--env=ENV_PATH=deployment',
        '--migration-directory=database/custom'
      )
      assert.equal(process.exitCode, 0)
      const written = await readdir(join(root, 'database/custom'))
      assert.lengthOf(written, 1)
      assert.match(written[0], /_account_kit_admission_create_account_admissions\.ts$/)
      assert.lengthOf(await readdir(join(root, 'database/migrations')), 0)
    } finally {
      process.exitCode = previousExitCode
      await rm(root, { recursive: true, force: true })
    }
  }).timeout(commandTimeout)

  test('refuses a selected path that lacks the admission migration another configured path holds', async ({
    assert,
  }) => {
    const { root, run } = await fixture()
    const previousExitCode = process.exitCode
    const errors: string[] = []
    const logError = console.error
    try {
      await rm(join(root, 'database/migrations'), { recursive: true })
      await mkdir(join(root, 'database/landlord'))
      await mkdir(join(root, 'database/tenant'))
      await writeFile(
        join(root, 'config/database.ts'),
        "import { defineConfig } from '@adonisjs/lucid'\nexport default defineConfig({ connection: 'sqlite', connections: { sqlite: { client: 'better-sqlite3', migrations: { paths: ['database/landlord', 'database/tenant'] } } } })"
      )
      // Other Account Kit migrations elsewhere do not block the admission migration.
      await writeFile(
        join(root, 'database/landlord/1700000000000_account_kit_create_account_invitations.ts'),
        '// existing migration'
      )
      await run('--migration-directory=database/tenant')
      assert.equal(process.exitCode, 0)
      assert.lengthOf(await readdir(join(root, 'database/tenant')), 1)

      // Wrong path: the admission migration exists in tenant, landlord selected.
      await rm(join(root, 'config/admission.ts'))
      process.exitCode = undefined
      console.error = (...parts: unknown[]) => errors.push(parts.join(' '))
      await run('--migration-directory=database/landlord')
      console.error = logError
      assert.equal(process.exitCode, 1)
      assert.isTrue(
        errors.some(
          (line) =>
            line.includes(
              'The configured Lucid migration path database/tenant already holds Account Kit migrations that database/landlord lacks'
            ) && line.includes('Nothing was written')
        )
      )
      assert.lengthOf(await readdir(join(root, 'database/landlord')), 1)
      await assert.rejects(() => readFile(join(root, 'config', 'admission.ts'), 'utf8'))
    } finally {
      console.error = logError
      process.exitCode = previousExitCode
      await rm(root, { recursive: true, force: true })
    }
  }).timeout(commandTimeout)

  test('does not duplicate an admission command loader written with double quotes', async ({
    assert,
  }) => {
    const { root, run } = await fixture()
    try {
      const rcPath = join(root, 'adonisrc.ts')
      await writeFile(
        rcPath,
        [
          "import { defineConfig } from '@adonisjs/core/app'",
          'export default defineConfig({ providers: [], commands: [() => import("@kevinjohn/adonisjs-account-kit/admission/commands")] })',
          '',
        ].join('\n')
      )

      await run()
      await run()

      const rc = await readFile(rcPath, 'utf8')
      assert.equal(rc.match(/@kevinjohn\/adonisjs-account-kit\/admission\/commands/g)?.length, 1)
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
