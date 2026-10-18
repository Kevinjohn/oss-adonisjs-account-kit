// Transaction engine: SQLite busy-retry, and PostgreSQL and MySQL commit wrapping with committed-fault reporting.
import { performance } from 'node:perf_hooks'
import type { Database } from '@adonisjs/lucid/database'
import { PostCommitError } from './errors.js'
import type { Trx } from './types.js'

const SQLITE_RETRY_MS = 10
const SQLITE_DEADLINE_MS = 5000

interface SQLiteConnection {
  inTransaction: boolean
  exec(sql: string): void
  pragma(sql: string, options?: { simple: boolean }): unknown
  __knex__disposed?: Error
}

function isBusy(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error.code === 'SQLITE_BUSY' || error.code === 'SQLITE_BUSY_SNAPSHOT')
  )
}

async function lockSQLiteTransaction(trx: Trx): Promise<void> {
  let rows: Array<{ id: number }>
  try {
    rows = await trx
      .rawQuery('update account_transaction_lock set version = version where id = 1 returning id')
      .exec()
  } catch (error) {
    if (
      (error as { code?: string; message?: string }).code === 'SQLITE_ERROR' &&
      (error as Error).message.includes('no such table: account_transaction_lock')
    ) {
      throw new Error(
        'Account kit SQLite transaction lock is missing; run the account_transaction_lock migration',
        { cause: error }
      )
    }
    throw error
  }
  if (rows.length !== 1) {
    throw new Error('Account kit SQLite transaction lock row is missing; restore singleton id=1')
  }
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
      const cleanup: unknown[] = []
      try {
        if (sqlite?.inTransaction) sqlite.exec('ROLLBACK')
      } catch (failure) {
        cleanup.push(failure)
      }
      // Knex has completed and released the failed transaction. PostgreSQL has
      // rolled it back; SQLite may need the native cleanup above. Emit Lucid's
      // rollback lifecycle without sending another query through a closed client.
      const originalRollback = knexTrx.rollback
      knexTrx.rollback = (() => Promise.resolve()) as typeof originalRollback
      try {
        await trx.rollback()
      } catch (failure) {
        cleanup.push(failure)
      } finally {
        knexTrx.rollback = originalRollback
      }
      throw combineFailures(error, cleanup)
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
  onResult: (result: T) => void,
  sqlite?: SQLiteConnection
): Promise<T> {
  try {
    const result = await callback(trx)
    onResult(result)
    await commitTransaction(trx, onCommitted, sqlite)
    return result
  } catch (error) {
    if (!trx.isCompleted) {
      try {
        await trx.rollback()
      } catch (failure) {
        throw combineFailures(error, [failure])
      }
    }
    throw error
  }
}

const committedResults = new WeakMap<PostCommitError, unknown>()

/** Internal operation data is retained privately, never placed on a public committed error. */
export function committedResult<T>(error: unknown): { value: T } | null {
  if (!(error instanceof PostCommitError) || !committedResults.has(error)) return null
  return { value: committedResults.get(error) as T }
}

function committedFailure<T>(cause: unknown, result: T): PostCommitError {
  const error = new PostCommitError('Account change committed but a follow-up failed', { cause })
  committedResults.set(error, result)
  return error
}

function combineFailures(primary: unknown, cleanup: unknown[]): unknown {
  if (cleanup.length === 0) return primary
  return primary === undefined && cleanup.length === 1
    ? cleanup[0]
    : new AggregateError(primary === undefined ? cleanup : [primary, ...cleanup])
}

/**
 * Timestamps are written as UTC wall time; mysql2's default `timezone: 'local'` would read them
 * back shifted by the host's offset and push credential revisions forward on every change.
 */
function requireUtcMysqlClient(db: Database, connectionName: string): void {
  const connection = db.manager.get(connectionName)?.config.connection as
    | { timezone?: string }
    | undefined
  const timezone = connection?.timezone
  if (timezone === 'Z' || timezone === '+00:00') return
  throw new Error(
    `Account kit requires timezone: 'Z' on the MySQL connection "${connectionName}" (found ${JSON.stringify(timezone ?? 'local')})`
  )
}

/**
 * MySQL runs at READ COMMITTED so reads after a row lock see the latest committed rows; InnoDB's
 * default REPEATABLE READ would keep serving the snapshot taken before the lock was granted.
 */
function beginTransaction(
  db: Database,
  connection: ReturnType<Database['connection']>
): Promise<Trx> {
  if (connection.dialect.name !== 'mysql') return connection.transaction()
  requireUtcMysqlClient(db, connection.connectionName)
  // Lucid forwards options only from the second argument; the options-only overload drops them.
  const begin = connection.transaction.bind(connection) as unknown as (
    callback: undefined,
    options: { isolationLevel: 'read committed' }
  ) => Promise<Trx>
  return begin(undefined, { isolationLevel: 'read committed' })
}

/** Run a database-only callback; callers perform notifications after this resolves. */
export async function transaction<T>(db: Database, callback: (trx: Trx) => Promise<T>): Promise<T> {
  const connection = db.connection()
  if (connection.isTransaction) throw new Error('Account kit requires its own transaction')

  if (connection.dialect.name !== 'better-sqlite3') {
    let committed = false
    let result: T | undefined
    try {
      return await runAndCommit(
        await beginTransaction(db, connection),
        callback,
        () => {
          committed = true
        },
        (value) => {
          result = value
        }
      )
    } catch (error) {
      if (committed) throw committedFailure(error, result as T)
      throw error
    }
  }
  const client = connection.getWriteClient().client

  const deadline = performance.now() + SQLITE_DEADLINE_MS
  for (;;) {
    let committed = false
    let result: T | undefined
    try {
      const sqlite = (await client.acquireConnection()) as SQLiteConnection
      let timeout: number | undefined
      let outcome: T | undefined
      let failure: unknown
      let failed = false
      const cleanup: unknown[] = []
      try {
        timeout = Number(sqlite.pragma('busy_timeout', { simple: true }))
        sqlite.pragma('busy_timeout = 0')
        const trx = (await connection.transaction(
          undefined as never,
          { connection: sqlite } as never
        )) as Trx
        outcome = await runAndCommit(
          trx,
          async (sqliteTrx) => {
            await lockSQLiteTransaction(sqliteTrx)
            return callback(sqliteTrx)
          },
          () => {
            committed = true
          },
          (value) => {
            result = value
          },
          sqlite
        )
      } catch (error) {
        failure = error
        failed = true
      } finally {
        try {
          if (sqlite.inTransaction) sqlite.exec('ROLLBACK')
        } catch (error) {
          cleanup.push(error)
        }
        try {
          if (timeout !== undefined) sqlite.pragma(`busy_timeout = ${timeout}`)
        } catch (error) {
          cleanup.push(error)
        }
        if (cleanup.length > 0 || sqlite.inTransaction) {
          sqlite.__knex__disposed = new Error('Account kit discarded a dirty SQLite connection')
        }
        try {
          await client.releaseConnection(sqlite)
        } catch (error) {
          cleanup.push(error)
        }
      }
      if (failed || cleanup.length > 0) throw combineFailures(failure, cleanup)
      return outcome as T
    } catch (error) {
      if (committed) throw committedFailure(error, result as T)
      if (!isBusy(error) || performance.now() >= deadline) throw error
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(SQLITE_RETRY_MS, Math.max(0, deadline - performance.now())))
      )
    }
  }
}
