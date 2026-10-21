import type { TestApp } from './app.js'

/** Package tables keyed by the user, with the column that holds the user id. */
export const userTables = [
  ['social_handoff_codes', 'user_id'],
  ['social_sensitive_proofs', 'user_id'],
  ['social_transactions', 'user_id'],
  ['social_identities', 'user_id'],
  ['password_reset_tokens', 'tokenable_id'],
  ['email_verification_tokens', 'tokenable_id'],
  ['login_link_tokens', 'tokenable_id'],
  ['account_sessions', 'user_id'],
  ['account_invitations', 'inviter_id'],
  ['auth_access_tokens', 'tokenable_id'],
] as const

/** Tables that hold rows: every user-keyed table, then the users table. */
const dataTables = [...userTables.map(([table]) => table), 'users']

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
