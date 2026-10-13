import { performance } from 'node:perf_hooks'
import { DateTime } from 'luxon'
import type { Database } from '@adonisjs/lucid/database'
import { InvalidTokenError } from './errors.js'
import { hashToken } from './tokens.js'
import type { AccountUser, ResolvedConfig, Trx, UserId } from './types.js'

const SQLITE_RETRY_MS = 10
const SQLITE_DEADLINE_MS = 5000

interface SQLiteConnection {
  inTransaction: boolean
  exec(sql: string): void
  pragma(sql: string, options?: { simple: boolean }): unknown
}

function isBusy(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error.code === 'SQLITE_BUSY' || error.code === 'SQLITE_BUSY_SNAPSHOT')
  )
}

export function isUniqueViolation(error: unknown, table: string, column: string): boolean {
  if (typeof error !== 'object' || error === null) return false

  const details = error as { code?: unknown; constraint?: unknown; message?: unknown }
  if (details.code === '23505') {
    // PostgreSQL stores at most 63 bytes of an identifier; configured table names are ASCII.
    return details.constraint === `${table}_${column}_unique`.slice(0, 63)
  }

  if (details.code !== 'SQLITE_CONSTRAINT_UNIQUE' || typeof details.message !== 'string')
    return false
  const prefix = 'UNIQUE constraint failed: '
  const start = details.message.lastIndexOf(prefix)
  if (start < 0) return false
  // A multi-column index lists its columns comma-separated, so this only matches a single column.
  return details.message.slice(start + prefix.length).trim() === `${table}.${column}`
}

/** SQLite has no row locks: a touch update takes the database write lock for the transaction. */
export async function lockRow(trx: Trx, table: string, id: UserId): Promise<void> {
  if (trx.dialect.name !== 'better-sqlite3') return
  await trx.rawQuery('update ?? set id = id where id = ?', [table, id]).exec()
}

type TokenTable = 'account_recovery_tokens' | 'account_email_changes' | 'account_invitations'

/** Delete one unexpired token row and return it, or null when no live row matched. */
export async function consumeToken<Row>(
  trx: Trx,
  table: TokenTable,
  tokenHash: string,
  now: string
): Promise<Row | null> {
  const result: unknown = await trx
    .rawQuery(`delete from ${table} where token_hash = ? and expires_at > ? returning *`, [
      tokenHash,
      now,
    ])
    .exec()
  // better-sqlite3 returns the rows directly; pg wraps them in a result object.
  const rows = (Array.isArray(result) ? result : (result as { rows: Row[] }).rows) as Row[]
  return rows[0] ?? null
}

/**
 * Consume a user-bound token under the user's lock. Every credential operation locks the user
 * before touching a token table, so the unlocked lookup only chooses the lock target; the
 * consuming delete then revalidates the live token.
 */
export async function consumeUserToken<Row extends { user_id: UserId }>(
  trx: Trx,
  config: ResolvedConfig,
  table: 'account_recovery_tokens' | 'account_email_changes',
  token: string,
  emailOf: (row: Row) => string
): Promise<{ row: Row; user: AccountUser }> {
  const tokenHash = hashToken(token)
  const candidate = await trx.from(table).select('user_id').where('token_hash', tokenHash).first()
  if (!candidate) throw new InvalidTokenError()
  await lockRow(trx, config.usersTable, candidate.user_id)
  const user = await config.users.findById(candidate.user_id, trx, { forUpdate: true })
  const row = await consumeToken<Row>(trx, table, tokenHash, DateTime.utc().toISO())
  if (!row || row.user_id !== candidate.user_id || !user || user.email !== emailOf(row))
    throw new InvalidTokenError()
  return { row, user }
}

async function commitTransaction(
  trx: Trx,
  onCommitted: () => void,
  sqlite?: SQLiteConnection
): Promise<void> {
  const knexTrx = trx.getWriteClient()
  const completion = knexTrx.executionPromise
  void completion.catch(() => {})
  const originalCommit = knexTrx.commit

  // Knex can resolve its COMMIT query even when the database rejects it. Lucid must not
  // emit commit or run after-commit hooks until Knex's completion promise settles.
  knexTrx.commit = (async () => {
    try {
      await originalCommit.call(knexTrx)
      await completion
      onCommitted()
    } catch (error) {
      if (sqlite?.inTransaction) sqlite.exec('ROLLBACK')
      // Knex has completed and released the failed transaction. PostgreSQL has
      // rolled it back; SQLite may need the native cleanup above. Emit Lucid's
      // rollback lifecycle without sending another query through a closed client.
      const originalRollback = knexTrx.rollback
      knexTrx.rollback = (() => Promise.resolve()) as typeof originalRollback
      try {
        await trx.rollback()
      } finally {
        knexTrx.rollback = originalRollback
      }
      throw error
    }
  }) as typeof originalCommit

  try {
    await trx.commit()
  } finally {
    knexTrx.commit = originalCommit
  }
}

async function runAndCommit<T>(
  trx: Trx,
  callback: (trx: Trx) => Promise<T>,
  onCommitted: () => void,
  sqlite?: SQLiteConnection
): Promise<T> {
  try {
    const result = await callback(trx)
    await commitTransaction(trx, onCommitted, sqlite)
    return result
  } catch (error) {
    if (!trx.isCompleted) await trx.rollback()
    throw error
  }
}

/** Run a database-only callback; callers perform notifications after this resolves. */
export async function transaction<T>(db: Database, callback: (trx: Trx) => Promise<T>): Promise<T> {
  const connection = db.connection()
  if (connection.isTransaction) throw new Error('Account kit requires its own transaction')

  if (connection.dialect.name !== 'better-sqlite3') {
    return runAndCommit(await connection.transaction(), callback, () => {})
  }
  const client = connection.getWriteClient().client

  const deadline = performance.now() + SQLITE_DEADLINE_MS
  for (;;) {
    let committed = false
    try {
      const sqlite = (await client.acquireConnection()) as SQLiteConnection
      let timeout: number | undefined
      try {
        timeout = Number(sqlite.pragma('busy_timeout', { simple: true }))
        sqlite.pragma('busy_timeout = 0')
        const trx = (await connection.transaction(
          undefined as never,
          { connection: sqlite } as never
        )) as Trx
        return await runAndCommit(
          trx,
          callback,
          () => {
            committed = true
          },
          sqlite
        )
      } finally {
        if (sqlite.inTransaction) sqlite.exec('ROLLBACK')
        if (timeout !== undefined) sqlite.pragma(`busy_timeout = ${timeout}`)
        await client.releaseConnection(sqlite)
      }
    } catch (error) {
      if (committed || !isBusy(error) || performance.now() >= deadline) throw error
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(SQLITE_RETRY_MS, Math.max(0, deadline - performance.now())))
      )
    }
  }
}
