import { mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MigrationRunner } from '@adonisjs/lucid/migration'
import { migrationNames, migrationSchema } from '../../configure.js'
import type { TestApp } from './app.js'

export async function resetSchema(
  kit: TestApp,
  options: { stringUserIds?: boolean; usersTable?: string } = {}
): Promise<void> {
  const usersTable = options.usersTable ?? 'users'
  const schema = kit.db.connection().schema
  await schema.dropTableIfExists('auth_access_tokens')
  await schema.dropTableIfExists('login_link_tokens')
  await schema.dropTableIfExists('account_sessions')
  await schema.dropTableIfExists('account_transaction_lock')
  await schema.dropTableIfExists('email_verification_tokens')
  await schema.dropTableIfExists('social_handoff_codes')
  await schema.dropTableIfExists('social_sensitive_proofs')
  await schema.dropTableIfExists('social_identities')
  await schema.dropTableIfExists('social_transactions')
  await schema.dropTableIfExists('account_email_changes')
  await schema.dropTableIfExists('account_invitations')
  await schema.dropTableIfExists('password_reset_tokens')
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

const dataTables = [
  'auth_access_tokens',
  'login_link_tokens',
  'account_sessions',
  'account_invitations',
  'password_reset_tokens',
  'email_verification_tokens',
  'social_identities',
  'social_sensitive_proofs',
  'social_handoff_codes',
  'social_transactions',
  'users',
]

/** Empty every table and restart id sequences without touching the schema. */
export async function clearRows(kit: TestApp): Promise<void> {
  const dialect = kit.db.connection().dialect.name
  if (dialect === 'mysql') {
    // One pooled connection, so the session setting applies to every truncate.
    await kit.db.transaction(async (trx) => {
      await trx.rawQuery('set foreign_key_checks = 0')
      for (const table of dataTables) await trx.rawQuery(`truncate table ${table}`)
      await trx.rawQuery('set foreign_key_checks = 1')
    })
    return
  }
  if (dialect !== 'better-sqlite3') {
    await kit.db.rawQuery(`truncate ${dataTables.join(', ')} restart identity cascade`)
    return
  }
  for (const table of dataTables) await kit.db.from(table).delete()
  await kit.db.rawQuery(
    `delete from sqlite_sequence where name in (${dataTables.map(() => '?').join(', ')})`,
    dataTables
  )
}
