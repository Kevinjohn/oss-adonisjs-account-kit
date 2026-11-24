import { RuntimeException } from '@adonisjs/core/exceptions'
// Transaction engine: SQLite busy-retry, and PostgreSQL and MySQL commit wrapping with committed-fault reporting.
import { AsyncLocalStorage } from 'node:async_hooks'
import { performance } from 'node:perf_hooks'
import type { Database } from '@adonisjs/lucid/database'
import {
  E_ACCOUNT_KIT_POST_COMMIT,
  E_ACCOUNT_KIT_COMMITTED_TRANSACTION_FAILED,
  E_ACCOUNT_KIT_TRANSACTION_CLEANUP_FAILED,
} from './errors.js'
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
      throw new RuntimeException(
        'Account kit SQLite transaction lock is missing; run the account_transaction_lock migration',
        { cause: error }
      )
    }
    throw error
  }
  if (rows.length !== 1) {
    throw new RuntimeException(
      'Account kit SQLite transaction lock row is missing; restore singleton id=1'
    )
  }
}

async function commitTransaction(
  trx: Trx,
  onCommitted: () => void,
  cleanup: unknown[],
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
      throw error
    }
  }) as typeof originalCommit

  try {
    await trx.commit()
  } finally {
    knexTrx.commit = originalCommit
  }
}

/** @throws {AggregateError} Work and cleanup both failed. The work failure is first. */
async function runAndCommit<T>(
  trx: Trx,
  callback: (trx: Trx) => Promise<T>,
  onCommitted: () => void,
  onResult: (result: T) => void,
  sqlite?: SQLiteConnection,
  cleanup?: unknown[]
): Promise<T> {
  const failures = cleanup ?? []
  try {
    const result = await callback(trx)
    onResult(result)
    await commitTransaction(trx, onCommitted, failures, sqlite)
    return result
  } catch (error) {
    if (!trx.isCompleted) {
      try {
        await trx.rollback()
      } catch (failure) {
        failures.push(failure)
      }
    }
    if (!cleanup && failures.length) throw new AggregateError([error, ...failures])
    throw error
  }
}

const committedResults = new WeakMap<InstanceType<typeof E_ACCOUNT_KIT_POST_COMMIT>, unknown>()

/** Internal operation data is retained privately, never placed on a public committed error. */
export function getCommittedResult<T>(error: unknown): { value: T } | null {
  if (!(error instanceof E_ACCOUNT_KIT_POST_COMMIT) || !committedResults.has(error)) return null
  return { value: committedResults.get(error) as T }
}

function createCommittedFailure<T>(
  cause: unknown,
  result: T
): InstanceType<typeof E_ACCOUNT_KIT_POST_COMMIT> {
  const error = new E_ACCOUNT_KIT_COMMITTED_TRANSACTION_FAILED(
    'Account change committed but a follow-up failed',
    {
      cause,
    }
  )
  committedResults.set(error, result)
  return error
}

/**
 * Timestamps are written as UTC wall time; mysql2's default `timezone: 'local'` would read them
 * back shifted by the host's offset and push credential revisions forward on every change.
 */
function requireUtcMysqlClient(db: Database, connectionName: string): void {
  const config = db.manager.get(connectionName)?.config
  const timezone = (config?.connection as { timezone?: string } | undefined)?.timezone
  if (timezone === 'Z' || timezone === '+00:00') return
  throw new RuntimeException(
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

type Connection = ReturnType<Database['connection']>

/** Records the callback's result and whether the commit landed, for reporting a later failure. */
function trackCommit<T>() {
  let committed = false
  let result: T | undefined
  return {
    get committed() {
      return committed
    },
    onCommitted: () => {
      committed = true
    },
    onResult: (value: T) => {
      result = value
    },
    /** A failure after the commit becomes a `E_ACCOUNT_KIT_POST_COMMIT`; any other is returned unchanged. */
    mapTransactionFailure: (error: unknown): unknown =>
      committed ? createCommittedFailure(error, result as T) : error,
  }
}

async function beginSQLiteTransaction(
  connection: Connection,
  sqlite: SQLiteConnection
): Promise<Trx> {
  if (!('pinnedConnection' in connection)) {
    return connection.transaction(undefined as never, { connection: sqlite } as never)
  }

  // Lucid 22.5 takes the checkout from the query client instead of the transaction options.
  // Database.connection() gives each Account Kit transaction operation its own query client.
  const queryClient = connection as { pinnedConnection: unknown }
  const previous = queryClient.pinnedConnection
  queryClient.pinnedConnection = sqlite
  try {
    return await connection.transaction()
  } finally {
    queryClient.pinnedConnection = previous
  }
}

/**
 * One SQLite attempt on a dedicated connection, with busy_timeout off and cleanup afterwards.
 *
 * @throws {AggregateError} Work and cleanup both failed. The work failure is first.
 */
async function runSqliteTransactionAttempt<T>(
  connection: Connection,
  callback: (trx: Trx) => Promise<T>,
  commit: ReturnType<typeof trackCommit<T>>
): Promise<T> {
  const client = connection.getWriteClient().client
  const sqlite = (await client.acquireConnection()) as SQLiteConnection
  let timeout: number | undefined
  let result: T | undefined
  let failure: unknown
  let failed = false
  const cleanup: unknown[] = []
  try {
    timeout = Number(sqlite.pragma('busy_timeout', { simple: true }))
    sqlite.pragma('busy_timeout = 0')
    const trx = await beginSQLiteTransaction(connection, sqlite)
    result = await runAndCommit(
      trx,
      async (sqliteTrx) => {
        await lockSQLiteTransaction(sqliteTrx)
        return callback(sqliteTrx)
      },
      commit.onCommitted,
      commit.onResult,
      sqlite,
      cleanup
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
  if (failed) {
    if (cleanup.length) throw new AggregateError([failure, ...cleanup])
    throw failure
  }
  if (cleanup.length === 1) throw cleanup[0]
  if (cleanup.length > 1) throw new E_ACCOUNT_KIT_TRANSACTION_CLEANUP_FAILED(cleanup)
  return result as T
}

/**
 * Retry SQLite attempts on SQLITE_BUSY until the deadline; never retry after a commit.
 *
 * @throws {AggregateError} Work and cleanup both failed. The work failure is first.
 */
async function runSqliteTransaction<T>(
  connection: Connection,
  callback: (trx: Trx) => Promise<T>
): Promise<T> {
  const deadline = performance.now() + SQLITE_DEADLINE_MS
  for (;;) {
    const commit = trackCommit<T>()
    try {
      return await runSqliteTransactionAttempt(connection, callback, commit)
    } catch (error) {
      if (commit.committed) throw commit.mapTransactionFailure(error)
      if (!isBusy(error) || performance.now() >= deadline) throw error
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(SQLITE_RETRY_MS, Math.max(0, deadline - performance.now())))
      )
    }
  }
}

/** Set while a package transaction's callback runs, so a nested call fails instead of hanging. */
const insideTransaction = new AsyncLocalStorage<true>()

/**
 * Run a database-only callback; callers perform notifications after this resolves.
 *
 * @throws {AggregateError} Transaction work and cleanup both failed. The work failure is first,
 * followed by cleanup failures in observed order.
 * @throws {E_ACCOUNT_KIT_COMMITTED_TRANSACTION_FAILED} Finalisation failed after commit.
 *
 * @example
 * ```ts
 * import { transaction } from '@kevinjohn/adonisjs-account-kit/transaction'
 * import db from '@adonisjs/lucid/services/db'
 *
 * await transaction(db, async (trx) => {
 *   await trx.from('users').where('id', userId).update({ display_name: 'Sam Example' })
 * })
 * ```
 */
export async function transaction<T>(db: Database, callback: (trx: Trx) => Promise<T>): Promise<T> {
  const connection = db.connection()
  if (connection.isTransaction)
    throw new RuntimeException('Account kit requires its own transaction')
  // On SQLite a nested call waits for the outer writer lock; elsewhere it commits on its own.
  if (insideTransaction.getStore())
    throw new RuntimeException(
      'Account kit transactions cannot be nested; use the trx you were given'
    )
  return insideTransaction.run(true, () => openTransaction(db, connection, callback))
}

/** @throws {AggregateError} Work and cleanup both failed. The work failure is first. */
async function openTransaction<T>(
  db: Database,
  connection: Connection,
  callback: (trx: Trx) => Promise<T>
): Promise<T> {
  if (connection.dialect.name === 'better-sqlite3')
    return runSqliteTransaction(connection, callback)

  const commit = trackCommit<T>()
  try {
    return await runAndCommit(
      await beginTransaction(db, connection),
      callback,
      commit.onCommitted,
      commit.onResult
    )
  } catch (error) {
    throw commit.mapTransactionFailure(error)
  }
}
