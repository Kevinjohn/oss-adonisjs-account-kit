import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
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

  test('refuses a selected path that lacks Account Kit migrations another configured path holds', async ({
    assert,
  }) => {
    const { root } = await fixture()
    const lucidPaths = async (paths: string) =>
      writeFile(
        join(root, 'config/database.ts'),
        `import { defineConfig } from '@adonisjs/lucid'
export default defineConfig({ connection: 'sqlite', connections: { sqlite: { client: 'better-sqlite3', migrations: { paths: [${paths}] } } } })`
      )
    const place = async (directory: string, names: readonly string[]) => {
      await mkdir(join(root, directory), { recursive: true })
      for (const [index, name] of names.entries())
        await writeFile(
          join(root, directory, `${1_700_000_000_000 + index}_account_kit_${name}.ts`),
          '// existing migration'
        )
    }

    // Split install: half the migrations in each path.
    await lucidPaths("'database/migrations', 'database/tenant'")
    await place('database/migrations', migrationNames.slice(0, 6))
    await place('database/tenant', migrationNames.slice(6))
    const split = await inspectSetup(root, { migrationDirectory: 'database/migrations' })
    assert.equal(
      split.migrationDirectoryError,
      'The configured Lucid migration path database/tenant already holds Account Kit migrations that database/migrations lacks, and Lucid runs every configured path; select the path that holds them with --migration-directory or reconcile the migration paths manually before generating another copy'
    )
    assert.equal(split.migrationDirectoryErrorField, 'database/tenant')

    // Wrong path: every migration in the other path.
    await lucidPaths("'database/landlord', 'database/tenant'")
    await rm(join(root, 'database'), { recursive: true })
    await place('database/landlord', migrationNames)
    await mkdir(join(root, 'database/tenant'))
    const wrong = await inspectSetup(root, { migrationDirectory: 'database/tenant' })
    assert.equal(wrong.migrationDirectoryErrorField, 'database/landlord')
    assert.include(
      wrong.migrationDirectoryError,
      'database/landlord already holds Account Kit migrations that database/tenant lacks'
    )
    const right = await inspectSetup(root, { migrationDirectory: 'database/landlord' })
    assert.isUndefined(right.migrationDirectoryError)
    assert.equal(right.migrationDirectory, 'database/landlord')
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

  test('skips an unusable configured path while choosing another, in either order', async ({
    assert,
  }) => {
    for (const paths of [
      "'../shared/migrations', 'database/migrations'",
      "'database/migrations', '../shared/migrations'",
    ]) {
      const { root, choices } = await fixture()
      const lucidPaths = (list: string) =>
        writeFile(
          join(root, 'config/database.ts'),
          `import { defineConfig } from '@adonisjs/lucid'
export default defineConfig({ connection: 'sqlite', connections: { sqlite: { client: 'better-sqlite3', migrations: { paths: [${list}] } } } })`
        )
      await lucidPaths(paths)
      // Nothing generated yet: the unusable path cannot be ruled out, so setup says so.
      const fresh = await inspectSetup(root)
      assert.equal(
        fresh.migrationDirectoryError,
        `The Lucid connection lists several migration paths (${paths.replaceAll("'", '')}) and Account Kit generates into one of them; pass --migration-directory with the configured path to use`,
        paths
      )
      const named = await inspectSetup(root, { migrationDirectory: 'database/migrations' })
      assert.equal(
        named.migrationDirectoryError,
        'Setup cannot inspect the configured Lucid migration path ../shared/migrations (Setup path escapes the application: ../shared/migrations), so it cannot rule out Account Kit migrations there that database/migrations lacks; Lucid runs every configured path. Make ../shared/migrations inspectable or reconcile the migration paths manually',
        paths
      )
      assert.equal(named.migrationDirectoryErrorField, '../shared/migrations', paths)

      // Installed: the usable path holds every migration, with or without the flag.
      await lucidPaths("'database/migrations'")
      await applySetup(root, await planSetup(choices, await inspectSetup(root), { apply: true }))
      await lucidPaths(paths)
      for (const migrationDirectory of [undefined, 'database/migrations']) {
        const installed = await inspectSetup(root, { migrationDirectory })
        assert.isUndefined(installed.migrationDirectoryError, paths)
        assert.equal(installed.migrationDirectory, 'database/migrations', paths)
      }
    }
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

  for (const [name, rc, message] of [
    [
      'an ambiguous adonisrc.ts config',
      'const shared = {}\nexport default { ...shared, providers: [] }\n',
      'Guided setup cannot establish directory settings from an ambiguous adonisrc.ts config; expose its directories statically before setup',
    ],
    [
      'adonisrc.ts directories that are not an object literal',
      'const directories = {}\nexport default { providers: [], directories: directories }\n',
      'Guided setup requires statically inspectable adonisrc.ts directories',
    ],
    [
      'a custom adonisrc.ts config directory',
      "export default { providers: [], directories: { config: 'settings' } }\n",
      'Guided setup requires the conventional config directory; use configure or reconcile setup manually',
    ],
    [
      'a dynamic adonisrc.ts migrations directory',
      "const migrations = 'database/custom'\nexport default { providers: [], directories: { migrations: migrations } }\n",
      'Guided setup requires a literal adonisrc.ts migrations directory',
    ],
  ] as const) {
    test(`refuses ${name}`, async ({ assert }) => {
      const { root } = await fixture()
      await writeFile(join(root, 'adonisrc.ts'), rc)
      const state = await inspectSetup(root)
      assert.equal(state.migrationDirectoryError, message)
      assert.equal(state.migrationDirectoryErrorField, 'adonisrc.ts')
    })
  }

  for (const [name, paths, explicit, message] of [
    [
      'a dynamic Lucid path without --migration-directory',
      'paths',
      undefined,
      'Unable to determine the Lucid migration directory statically; pass --migration-directory with the application-relative directory used by the selected connection',
    ],
    [
      'a --migration-directory with URL syntax',
      'paths',
      'database/custom#review',
      'Use a plain application-relative Lucid migration directory',
    ],
    [
      'a --migration-directory that differs from the configured path',
      "paths: ['database/custom']",
      'database/other',
      'The explicit migration directory differs from the configured Lucid migration directory',
    ],
  ] as const) {
    test(`refuses ${name}`, async ({ assert }) => {
      const { root } = await fixture()
      await writeFile(
        join(root, 'config/database.ts'),
        `import { defineConfig } from '@adonisjs/lucid'
const paths = ['database/custom']
export default defineConfig({ connection: 'sqlite', connections: { sqlite: { client: 'better-sqlite3', migrations: { ${paths} } } } })`
      )
      const state = await inspectSetup(root, { migrationDirectory: explicit })
      assert.equal(state.migrationDirectoryError, message)
    })
  }

  test('accepts a --migration-directory that may be a dynamic entry among several paths', async ({
    assert,
  }) => {
    const { root } = await fixture()
    await writeFile(
      join(root, 'config/database.ts'),
      `import { defineConfig } from '@adonisjs/lucid'
const tenant = 'database/custom'
export default defineConfig({ connection: 'sqlite', connections: { sqlite: { client: 'better-sqlite3', migrations: { paths: ['database/migrations', tenant] } } } })`
    )
    const state = await inspectSetup(root, { migrationDirectory: 'database/custom' })
    assert.isUndefined(state.migrationDirectoryError)
    assert.equal(state.migrationDirectory, 'database/custom')
  })

  test('refuses two existing copies of one Account Kit migration', ({ assert }) => {
    assert.throws(
      () =>
        orderedMigrations(
          [
            '1790000000000_account_kit_create_password_reset_tokens.ts',
            'prior/1780000000000_account_kit_create_password_reset_tokens.ts',
          ],
          1790000000001
        ),
      'Multiple existing migrations for create_password_reset_tokens; reconcile their history before setup'
    )
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
