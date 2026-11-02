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
    await kit.db.transaction(async (trx) => {
      // The transaction pins one session, although each TRUNCATE implicitly commits it.
      const connection = await trx.knexClient.client.acquireConnection()
      let previousChecks: number | undefined
      let primaryError: unknown
      let restorationError: unknown
      let hasPrimaryError = false
      let hasRestorationError = false
      let checksMayBeDisabled = false

      try {
        const result = await trx
          .rawQuery('select @@SESSION.foreign_key_checks as foreign_key_checks')
          .exec()
        const rows = Array.isArray(result[0]) ? result[0] : result
        previousChecks = Number(rows[0]?.foreign_key_checks)
        if (previousChecks !== 0 && previousChecks !== 1) {
          throw new Error('Could not read the MySQL session foreign_key_checks setting')
        }

        // A failed SET may still have reached the server, so restore it in either case.
        checksMayBeDisabled = true
        await trx.rawQuery('set SESSION foreign_key_checks = 0').exec()
        for (const table of dataTables) await trx.rawQuery(`truncate table ${table}`).exec()
      } catch (error) {
        primaryError = error
        hasPrimaryError = true
      } finally {
        if (checksMayBeDisabled) {
          try {
            await trx.rawQuery(`set SESSION foreign_key_checks = ${previousChecks}`).exec()
          } catch (error) {
            restorationError = error
            hasRestorationError = true
            // Defer destruction until Knex releases the transaction connection, after Lucid has
            // finished its rollback path. Knex's MySQL pool wrapper recognizes this marker.
            ;(connection as typeof connection & { __knex__disposed?: Error }).__knex__disposed =
              error instanceof Error ? error : new Error(String(error))
          }
        }
      }

      if (hasPrimaryError && hasRestorationError) {
        throw new AggregateError(
          [primaryError, restorationError],
          'Clearing MySQL test rows failed and foreign_key_checks could not be restored'
        )
      }
      if (hasPrimaryError) throw primaryError
      if (hasRestorationError) throw restorationError
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
