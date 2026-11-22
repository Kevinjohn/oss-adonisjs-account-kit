import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from '@japa/runner'
import { inspectSetup } from '../src/setup/inspect.js'
import { planSetup } from '../src/setup/plan.js'
import { applySetup } from '../src/setup/apply.js'
import { migrationContent, migrationTemplate } from '../src/setup/migration_source.js'
import { migrationNames, migrationSchema } from '../src/setup/migration_definitions.js'
import { parseSetupChoices } from '../src/setup/parse.js'
import { orderedMigrations } from '../src/setup/migration_order.js'
import { fixture, registerSetupTeardown } from './helpers/setup_project_fixture.js'

test.group('guided migration destinations', (group) => {
  registerSetupTeardown(group)

  test('reads the selected environment and default application migration directory for empty paths', async ({
    assert,
  }) => {
    const { root } = await fixture()
    await writeFile(
      join(root, 'adonisrc.ts'),
      "export default { providers: [], directories: { migrations: 'database/custom' } }"
    )
    await writeFile(
      join(root, 'config/database.ts'),
      `import { defineConfig } from '@adonisjs/lucid'\nimport env from '#start/env'\nexport default defineConfig({ connection: env.get('DB_CONNECTION'), connections: { sqlite: { client: 'better-sqlite3', migrations: { paths: ['database/sqlite'] } }, pg: { client: 'pg', migrations: { paths: [] } } } })`
    )
    const pg = await inspectSetup(root, { env: { DB_CONNECTION: 'pg' } })
    assert.equal(pg.database, 'postgres')
    assert.equal(pg.migrationDirectory, 'database/custom')
    const sqlite = await inspectSetup(root, { env: { DB_CONNECTION: 'sqlite' } })
    assert.equal(sqlite.database, 'sqlite')
    assert.equal(sqlite.migrationDirectory, 'database/sqlite')
    await writeFile(join(root, '.env.production'), 'DB_CONNECTION=pg\n')
    await writeFile(join(root, '.env'), 'DB_CONNECTION=sqlite\n')
    const selected = await inspectSetup(root, { env: { NODE_ENV: 'production' } })
    assert.equal(selected.migrationDirectory, 'database/custom')
  })

  test('requires explicit dynamic destination and rejects duplicate legacy migrations', async ({
    assert,
  }) => {
    const { root, choices } = await fixture()
    await writeFile(
      join(root, 'config/database.ts'),
      `import { defineConfig } from '@adonisjs/lucid'\nconst paths = ['database/custom']\nexport default defineConfig({ connection: 'sqlite', connections: { sqlite: { client: 'better-sqlite3', migrations: { paths } } } })`
    )
    const unresolved = await planSetup(choices, await inspectSetup(root))
    assert.isTrue(
      unresolved.diagnostics.some(({ message }) => message.includes('--migration-directory'))
    )
    const explicit = await inspectSetup(root, { migrationDirectory: 'database/custom' })
    assert.equal(explicit.migrationDirectory, 'database/custom')
    await mkdir(join(root, 'database/migrations'), { recursive: true })
    await writeFile(
      join(root, 'database/migrations/9999999999000_account_kit_create_account_invitations.ts'),
      '// old migration'
    )
    const conflict = await planSetup(
      choices,
      await inspectSetup(root, { migrationDirectory: 'database/custom' })
    )
    assert.isTrue(
      conflict.diagnostics.some(({ message }) =>
        message.includes('already exist in database/migrations')
      )
    )
  })

  test('checks an installed application whose Lucid connection lists several paths', async ({
    assert,
  }) => {
    const { root, choices } = await fixture()
    await applySetup(root, await planSetup(choices, await inspectSetup(root), { apply: true }))
    await writeFile(
      join(root, 'config/database.ts'),
      `import { defineConfig } from '@adonisjs/lucid'
export default defineConfig({ connection: 'sqlite', connections: { sqlite: { client: 'better-sqlite3', migrations: { paths: ['database/migrations', 'database/tenant'] } } } })`
    )
    const state = await inspectSetup(root)
    assert.isUndefined(state.migrationDirectoryError)
    assert.equal(state.migrationDirectory, 'database/migrations')
    const plan = await planSetup(choices, state)
    assert.deepEqual(
      plan.diagnostics.filter(({ severity }) => severity === 'error'),
      []
    )
    assert.equal(plan.migrationState, 'generated-application-unknown')
    assert.isTrue(
      plan.changes
        .filter(({ path }) => path.includes('_account_kit_'))
        .every(({ action }) => action === 'unchanged')
    )
  })

  test('generates in the configured path named by --migration-directory and refuses otherwise', async ({
    assert,
  }) => {
    const { root } = await fixture()
    await writeFile(
      join(root, 'config/database.ts'),
      `import { defineConfig } from '@adonisjs/lucid'
export default defineConfig({ connection: 'sqlite', connections: { sqlite: { client: 'better-sqlite3', migrations: { paths: ['database/migrations', './database/tenant'] } } } })`
    )
    const unselected = await inspectSetup(root)
    assert.equal(
      unselected.migrationDirectoryError,
      'The Lucid connection lists several migration paths (database/migrations, ./database/tenant) and Account Kit generates into one of them; pass --migration-directory with the configured path to use'
    )
    const selected = await inspectSetup(root, { migrationDirectory: 'database/tenant' })
    assert.isUndefined(selected.migrationDirectoryError)
    assert.equal(selected.migrationDirectory, 'database/tenant')
    const other = await inspectSetup(root, { migrationDirectory: 'database/other' })
    assert.equal(
      other.migrationDirectoryError,
      'The explicit migration directory is not one of the configured Lucid migration paths: database/migrations, ./database/tenant'
    )
  })

  test('reports a configured migration path outside the application as one diagnostic', async ({
    assert,
  }) => {
    const { root, choices } = await fixture()
    await writeFile(
      join(root, 'config/database.ts'),
      `import { defineConfig } from '@adonisjs/lucid'
export default defineConfig({ connection: 'sqlite', connections: { sqlite: { client: 'better-sqlite3', migrations: { paths: ['../shared/migrations'] } } } })`
    )
    const plan = await planSetup(choices, await inspectSetup(root))
    assert.deepEqual(
      plan.diagnostics.filter(({ severity }) => severity === 'error'),
      [
        {
          field: '../shared/migrations',
          message: 'Setup path escapes the application: ../shared/migrations',
          severity: 'error',
        },
      ]
    )
    assert.equal(plan.migrationState, 'unknown')
  })

  test('reports a non-directory migration path against that path', async ({ assert }) => {
    const { root, choices } = await fixture()
    await mkdir(join(root, 'database'))
    await writeFile(join(root, 'database/migrations'), '')
    const plan = await planSetup(choices, await inspectSetup(root))
    assert.deepEqual(
      plan.diagnostics.filter(({ severity }) => severity === 'error').map(({ field }) => field),
      ['database/migrations']
    )
  })

  test('does not report migrations as missing when their directory could not be used', async ({
    assert,
  }) => {
    const { root, choices } = await fixture()
    await applySetup(root, await planSetup(choices, await inspectSetup(root), { apply: true }))
    await writeFile(
      join(root, 'config/database.ts'),
      `import { defineConfig } from '@adonisjs/lucid'
export default defineConfig({ connection: 'sqlite', connections: { sqlite: { client: 'better-sqlite3', migrations: { paths: ['database/tenant'] } } } })`
    )
    const plan = await planSetup(choices, await inspectSetup(root))
    assert.equal(plan.migrationState, 'unknown')
    assert.deepEqual(
      plan.diagnostics.filter(({ severity }) => severity === 'error').map(({ field }) => field),
      ['database/migrations']
    )
  })

  test('files migration ordering conflicts under the migration directory', async ({ assert }) => {
    const { root, choices } = await fixture()
    await mkdir(join(root, 'database/migrations'), { recursive: true })
    await writeFile(
      join(
        root,
        'database/migrations/9999999999000_account_kit_add_scope_to_account_invitations.ts'
      ),
      '// existing successor'
    )
    const plan = await planSetup(choices, await inspectSetup(root))
    const conflict = plan.diagnostics.find(({ message }) =>
      message.startsWith('Migration order conflict')
    )
    assert.equal(conflict?.field, 'database/migrations')
  })

  test('accepts a Lucid path inside the conventional directory without mistaking it for legacy history', async ({
    assert,
  }) => {
    const { root } = await fixture()
    const directory = 'database/migrations/active'
    const filename = '9999999999000_account_kit_create_account_invitations.ts'
    await mkdir(join(root, directory), { recursive: true })
    await writeFile(join(root, directory, filename), '// current migration')
    await writeFile(
      join(root, 'config/database.ts'),
      `import { defineConfig } from '@adonisjs/lucid'
export default defineConfig({ connection: 'sqlite', connections: { sqlite: { client: 'better-sqlite3', migrations: { paths: ['${directory}'] } } } })`
    )
    const state = await inspectSetup(root)
    assert.equal(state.migrationDirectory, directory)
    assert.deepEqual(state.migrationNames, [filename])
    assert.isUndefined(state.migrationDirectoryError)
  })

  test('keeps a nested invitations migration and plans its scope change after it', async ({
    assert,
  }) => {
    const { root, choices } = await fixture()
    const directory = 'database/migrations/prior'
    await mkdir(join(root, directory), { recursive: true })
    const operation = 'create_account_invitations'
    const path = `${directory}/1999999999999_account_kit_${operation}.ts`
    const contents = await migrationContent(await migrationTemplate(operation), migrationSchema())
    await writeFile(join(root, path), contents)
    const hidden = join(root, 'database/migrations/.archive')
    const linked = join(root, 'linked-migrations')
    await mkdir(hidden)
    await mkdir(linked)
    await symlink(linked, join(root, 'database/migrations/linked'), 'dir')
    const filename = path.split('/').at(-1)!
    await writeFile(join(hidden, filename), contents)
    await writeFile(join(linked, filename), contents)
    const state = await inspectSetup(root)
    assert.deepEqual(state.migrationNames, [`prior/${filename}`])
    const first = await planSetup(choices, state, { apply: true })
    const matching = first.changes.filter((change) => change.path.endsWith(`_${operation}.ts`))
    assert.deepEqual(
      matching.map(({ action, path: name }) => [action, name]),
      [['unchanged', path]]
    )
    const scope = first.changes.find((change) =>
      change.path.endsWith('_add_scope_to_account_invitations.ts')
    )
    assert.equal(scope?.action, 'create')
    assert.isTrue(scope?.path.startsWith(directory + '/'))
    assert.isTrue(path < scope!.path)
    await applySetup(root, first)

    const second = await planSetup(choices, await inspectSetup(root), { apply: true })
    const migrations = second.changes.filter((change) => change.path.includes('_account_kit_'))
    assert.lengthOf(migrations, migrationNames.length)
    assert.isTrue(migrations.every(({ action }) => action === 'unchanged'))
    assert.equal(await readFile(join(root, path), 'utf8'), contents)
  })

  test('plans the documented API migration inventory on a fresh app', async ({ assert }) => {
    const { root } = await fixture()
    const choices = parseSetupChoices(
      JSON.parse(
        await readFile(
          new URL('../docs/reference/setup_choices.api.example.json', import.meta.url),
          'utf8'
        )
      )
    )
    const plan = await planSetup(choices, await inspectSetup(root))
    const migrations = plan.changes.filter(
      ({ path, action }) => action === 'create' && path.startsWith('database/migrations/')
    )
    assert.lengthOf(migrations, 12)
    assert.match(migrations.at(-1)!.path, /_add_scope_to_account_invitations\.ts$/)
  })

  test('refuses new migrations that would run before an untimestamped host migration', ({
    assert,
  }) => {
    assert.throws(
      () => orderedMigrations(['prior/create_users.ts'], 1790000000000),
      /Cannot establish migration order/
    )
  })

  test('refuses new migrations that cross a timestamp width boundary mid-plan', ({ assert }) => {
    assert.throws(
      () => orderedMigrations(['9999999999998_create_users.ts'], 1790000000000),
      /mixed-width/
    )
  })

  test('refuses timestamp prefixes for which numeric and lexical orders disagree', ({ assert }) => {
    assert.throws(() => orderedMigrations(['9999_create_users.ts'], 1790000000000), /mixed-width/)
    assert.throws(
      () => orderedMigrations(['999999999999999999999999_create_users.ts'], 1790000000000),
      /safe integer/
    )
  })
})
