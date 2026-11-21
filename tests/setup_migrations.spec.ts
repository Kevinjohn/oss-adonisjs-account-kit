import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from '@japa/runner'
import { inspectSetup } from '../src/setup/inspect.js'
import { planSetup } from '../src/setup/plan.js'
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

  test('refuses timestamp prefixes for which numeric and lexical orders disagree', ({ assert }) => {
    assert.throws(() => orderedMigrations(['9999_create_users.ts'], 1790000000000), /mixed-width/)
    assert.throws(
      () => orderedMigrations(['999999999999999999999999_create_users.ts'], 1790000000000),
      /safe integer/
    )
  })
})
