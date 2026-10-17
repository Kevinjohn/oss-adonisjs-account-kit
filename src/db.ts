import { performance } from 'node:perf_hooks'
import { DateTime } from 'luxon'
import { isSqlIdentifier } from './identifiers.js'
import type { Database } from '@adonisjs/lucid/database'
import { InvalidTokenError, PostCommitError } from './errors.js'
import { hashToken } from './tokens.js'
import type { AccountUser, ResolvedConfig, Trx, UserId, UsersAdapterMetadata } from './types.js'

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

/** Physical metadata is explicit for custom adapters and model-derived for the maintained adapter. */
export async function userMetadata(config: ResolvedConfig): Promise<UsersAdapterMetadata> {
  const metadata = config.users.resolveMetadata
    ? await config.users.resolveMetadata()
    : {
        table: config.usersTable,
        primaryKey: 'id' as const,
        emailConstraint: config.emailConstraint,
      }
  if (metadata.primaryKey !== 'id' || !isSqlIdentifier(metadata.table))
    throw new Error(
      'account_kit: adapter metadata must use a plain table name and physical id column'
    )
  return metadata
}

/** SQLite holds its writer lock from transaction start; PostgreSQL locks physical rows here. */
export async function lockRow(trx: Trx, table: string, id: UserId): Promise<void> {
  if (trx.dialect.name === 'better-sqlite3') return
  await trx.from(table).select('id').where('id', id).forUpdate().first()
}

export async function lockUser(trx: Trx, config: ResolvedConfig, id: UserId): Promise<void> {
  const metadata = await userMetadata(config)
  await lockRow(trx, metadata.table, id)
}

/** Identify only the actual unique email index; unrelated unique failures retain their identity. */
export async function isUserEmailUniqueViolation(
  error: unknown,
  config: ResolvedConfig,
  db: Database
): Promise<boolean> {
  if (!error || typeof error !== 'object') return false
  const details = error as { code?: string; constraint?: string }
  if (details.code !== '23505' && details.code !== 'SQLITE_CONSTRAINT_UNIQUE') return false
  const metadata = await userMetadata(config)
  if (details.code !== '23505') return isUniqueViolation(error, metadata.table, 'email')
  const explicit = config.emailConstraint ?? metadata.emailConstraint
  if (explicit !== undefined) return details.constraint === explicit
  const result = await db.rawQuery(
    `select idx.relname as name
       from pg_index i
       join pg_class tbl on tbl.oid = i.indrelid
       join pg_class idx on idx.oid = i.indexrelid
       join pg_namespace ns on ns.oid = tbl.relnamespace
       join pg_attribute col on col.attrelid = tbl.oid and col.attnum = i.indkey[0]
      where tbl.relname = ? and ns.nspname = current_schema()
        and i.indisunique and i.indnkeyatts = 1
        and i.indexprs is null and i.indpred is null and col.attname = 'email'`,
    [metadata.table]
  )
  return result.rows.some((row: { name: string }) => row.name === details.constraint)
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

type TokenTable = 'password_reset_tokens' | 'email_verification_tokens' | 'account_invitations'

/** Delete one unexpired token row and return it, or null when no live row matched. */
export async function consumeToken<Row>(
  trx: Trx,
  table: TokenTable,
  tokenHash: string,
  now: string
): Promise<Row | null> {
  const hashColumn = table === 'account_invitations' ? 'token_hash' : 'hash'
  const result: unknown = await trx
    .rawQuery(`delete from ${table} where ${hashColumn} = ? and expires_at > ? returning *`, [
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
export async function consumeUserToken<Row extends { tokenable_id: UserId }>(
  trx: Trx,
  config: ResolvedConfig,
  table: 'password_reset_tokens' | 'email_verification_tokens',
  token: string,
  validForUser: (row: Row, user: AccountUser) => boolean
): Promise<{ row: Row; user: AccountUser }> {
  return consumeUserTokenHash(trx, config, table, hashToken(token), validForUser)
}

/** Consume a hash already bound to a one-use server-side social transaction. */
export async function consumeUserTokenHash<Row extends { tokenable_id: UserId }>(
  trx: Trx,
  config: ResolvedConfig,
  table: 'password_reset_tokens' | 'email_verification_tokens',
  tokenHash: string,
  validForUser: (row: Row, user: AccountUser) => boolean
): Promise<{ row: Row; user: AccountUser }> {
  const candidate = await trx.from(table).select('tokenable_id').where('hash', tokenHash).first()
  if (!candidate) throw new InvalidTokenError()
  await lockUser(trx, config, candidate.tokenable_id)
  const user = await config.users.findById(candidate.tokenable_id, trx)
  const row = await consumeToken<Row>(trx, table, tokenHash, DateTime.utc().toISO())
  if (!row || row.tokenable_id !== candidate.tokenable_id || !user || !validForUser(row, user))
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

/** Run a database-only callback; callers perform notifications after this resolves. */
export async function transaction<T>(db: Database, callback: (trx: Trx) => Promise<T>): Promise<T> {
  const connection = db.connection()
  if (connection.isTransaction) throw new Error('Account kit requires its own transaction')

  if (connection.dialect.name !== 'better-sqlite3') {
    let committed = false
    let result: T | undefined
    try {
      return await runAndCommit(
        await connection.transaction(),
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
