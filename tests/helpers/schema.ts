import { mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MigrationRunner } from '@adonisjs/lucid/migration'
import { migrationNames, migrationSchema } from '../../configure.js'
import type { TestApp } from './app.js'

type SchemaBuilder = ReturnType<TestApp['db']['connection']>['schema']

/** Tables the package migrations create, newest first so children drop before their parents. */
export const packageTables = migrationNames
  .filter((name) => name.startsWith('create_'))
  .map((name) => name.slice('create_'.length))
  .reverse()

/** Drop every package table, if it exists. */
export async function dropPackageTables(schema: SchemaBuilder): Promise<void> {
  for (const table of packageTables) await schema.dropTableIfExists(table)
}

export async function resetSchema(
  kit: TestApp,
  options: { stringUserIds?: boolean; usersTable?: string } = {}
): Promise<void> {
  const usersTable = options.usersTable ?? 'users'
  const schema = kit.db.connection().schema
  await schema.dropTableIfExists('auth_access_tokens')
  await dropPackageTables(schema)
  await schema.dropTableIfExists('adonis_schema_versions')
  await schema.dropTableIfExists('adonis_schema')
  await schema.dropTableIfExists('users')
  if (usersTable !== 'users') await schema.dropTableIfExists(usersTable)
  await schema.createTable(usersTable, (table) => {
    if (options.stringUserIds) table.string('id', 36).primary()
    else table.increments('id')
    table.string('email').notNullable().unique()
    table.string('password').nullable()
    table.timestamp('disabled_at').nullable()
    table.timestamp('created_at').notNullable()
  })
  // The columns AdonisJS Auth creates for access tokens.
  await schema.createTable('auth_access_tokens', (table) => {
    table.increments('id')
    table.integer('tokenable_id').notNullable()
    table.string('type').nullable()
    table.string('name').nullable()
    table.string('hash').notNullable()
    table.text('abilities').nullable()
    table.timestamp('created_at').nullable()
    table.timestamp('updated_at').nullable()
    table.timestamp('last_used_at').nullable()
    table.timestamp('expires_at').nullable()
  })

  await rm(kit.migrationDirectory, { recursive: true, force: true })
  await mkdir(kit.migrationDirectory, { recursive: true })
  await symlink(
    fileURLToPath(new URL('../../node_modules', import.meta.url)),
    join(kit.migrationDirectory, 'node_modules')
  )
  const stubsRoot = fileURLToPath(new URL('../../stubs', import.meta.url))
  const timestamp = Date.now()
  const stubs = await kit.app.stubs.create()

  for (const [index, name] of migrationNames.entries()) {
    const filename = `${timestamp + index}_account_kit_${name}.ts`
    const stub = await stubs.build(`migrations/${name}.stub`, { source: stubsRoot })
    const prepared = await stub.prepare({
      migration: {
        ...migrationSchema(usersTable, options.stringUserIds ? 'string' : 'integer'),
        destination: join(kit.migrationDirectory, filename),
      },
    })
    await writeFile(prepared.destination, prepared.contents)
  }

  const runner = new MigrationRunner(kit.db, kit.app, { direction: 'up' })
  await runner.run()
  if (runner.error) throw runner.error
}

export { userTables, clearRows } from './test_rows.js'
