import { performance } from 'node:perf_hooks'
import type { Database } from '@adonisjs/lucid/database'
import type { Trx, UserId } from './types.js'

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
    return details.constraint === `${table}_${column}_unique`
  }

  return (
    details.code === 'SQLITE_CONSTRAINT_UNIQUE' &&
    typeof details.message === 'string' &&
    details.message.includes(`${table}.${column}`)
  )
}

export async function lockUser(trx: Trx, id: UserId): Promise<void> {
  if (trx.dialect.name !== 'better-sqlite3') return
  await trx.rawQuery('update users set id = id where id = ?', [id]).exec()
}

export async function lockInvitation(trx: Trx, id: number): Promise<void> {
  if (trx.dialect.name !== 'better-sqlite3') return
  await trx.rawQuery('update account_invitations set id = id where id = ?', [id]).exec()
}

async function commitSqlite(
  trx: Trx,
  sqlite: SQLiteConnection,
  onCommitted: () => void
): Promise<void> {
  const knexTrx = trx.getWriteClient()
  const completion = knexTrx.executionPromise
  void completion.catch(() => {})
  const originalCommit = knexTrx.commit

  // Knex resolves its COMMIT query even when SQLite rejects it. Lucid must not
  // emit commit or run after-commit hooks until Knex's completion promise settles.
  knexTrx.commit = (async () => {
    try {
      await originalCommit.call(knexTrx)
      await completion
      onCommitted()
    } catch (error) {
      if (sqlite.inTransaction) sqlite.exec('ROLLBACK')
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

export async function consumeRecoveryToken(
  trx: Trx,
  tokenHash: string,
  now: string
): Promise<{ user_id: UserId; email: string } | null> {
  const result: unknown = await trx
    .rawQuery(
      'delete from account_recovery_tokens where token_hash = ? and expires_at > ? returning user_id, email',
      [tokenHash, now]
    )
    .exec()
  const rows = Array.isArray(result)
    ? result
    : (result as { rows: Array<{ user_id: UserId; email: string }> }).rows
  return rows[0] ?? null
}

export async function consumeEmailChangeToken(
  trx: Trx,
  tokenHash: string,
  now: string
): Promise<{ user_id: UserId; current_email: string; new_email: string } | null> {
  const result: unknown = await trx
    .rawQuery(
      'delete from account_email_changes where token_hash = ? and expires_at > ? returning *',
      [tokenHash, now]
    )
    .exec()
  const rows = Array.isArray(result)
    ? result
    : (result as { rows: Array<{ user_id: UserId; current_email: string; new_email: string }> })
        .rows
  return rows[0] ?? null
}

export async function consumeInvitationToken(
  trx: Trx,
  tokenHash: string,
  now: string
): Promise<{
  id: number
  email: string
  role: string
  inviter_id: UserId | null
  token_hash: string
  expires_at: Date | string
  created_at: Date | string
  updated_at: Date | string
} | null> {
  const result: unknown = await trx
    .rawQuery(
      'delete from account_invitations where token_hash = ? and expires_at > ? returning *',
      [tokenHash, now]
    )
    .exec()
  const rows = Array.isArray(result) ? result : (result as { rows: unknown[] }).rows
  return rows[0] ?? null
}

/** Run a database-only callback; callers perform notifications after this resolves. */
export async function transaction<T>(db: Database, callback: (trx: Trx) => Promise<T>): Promise<T> {
  if (db.config.connections[db.primaryConnectionName].client !== 'better-sqlite3') {
    return db.transaction(callback)
  }

  const connection = db.connection()
  if (connection.isTransaction)
    throw new Error('Account kit requires its own transaction on SQLite')
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
        try {
          const result = await callback(trx)
          await commitSqlite(trx, sqlite, () => {
            committed = true
          })
          return result
        } catch (error) {
          if (!trx.isCompleted) await trx.rollback()
          throw error
        }
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
