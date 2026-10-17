import { DateTime } from 'luxon'
import { isSqlIdentifier } from './identifiers.js'
import type { Database } from '@adonisjs/lucid/database'
import { InvalidTokenError } from './errors.js'
import { hashToken } from './tokens.js'
import { transaction, committedResult } from './transaction.js'
import type { AccountUser, ResolvedConfig, Trx, UserId, UsersAdapterMetadata } from './types.js'

export { transaction, committedResult }

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

/** The slice of resolved config that locates and describes the users table. */
export type UsersStorage = Pick<ResolvedConfig, 'users' | 'usersTable' | 'emailConstraint'>

/** Physical metadata is explicit for custom adapters and model-derived for the maintained adapter. */
export async function userMetadata(config: UsersStorage): Promise<UsersAdapterMetadata> {
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

export async function lockUser(trx: Trx, config: UsersStorage, id: UserId): Promise<void> {
  const metadata = await userMetadata(config)
  await lockRow(trx, metadata.table, id)
}

/** Identify only the actual unique email index; unrelated unique failures retain their identity. */
export async function isUserEmailUniqueViolation(
  error: unknown,
  config: UsersStorage,
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

type TokenTable = 'password_reset_tokens' | 'email_verification_tokens' | 'account_invitations'

/**
 * Run a `delete ... returning` statement and return the deleted rows. better-sqlite3 returns the
 * rows directly; pg wraps them in a result object.
 */
export async function deleteReturning<Row>(
  client: Trx | Database,
  sql: string,
  bindings: unknown[]
): Promise<Row[]> {
  const result: unknown = await client.rawQuery(sql, bindings).exec()
  return (Array.isArray(result) ? result : (result as { rows: Row[] }).rows) as Row[]
}

/** Delete one unexpired token row and return it, or null when no live row matched. */
export async function consumeToken<Row>(
  trx: Trx,
  table: TokenTable,
  tokenHash: string,
  now: string
): Promise<Row | null> {
  const hashColumn = table === 'account_invitations' ? 'token_hash' : 'hash'
  const rows = await deleteReturning<Row>(
    trx,
    `delete from ${table} where ${hashColumn} = ? and expires_at > ? returning *`,
    [tokenHash, now]
  )
  return rows[0] ?? null
}

/**
 * Consume a user-bound token under the user's lock. Every credential operation locks the user
 * before touching a token table, so the unlocked lookup only chooses the lock target; the
 * consuming delete then revalidates the live token.
 */
export async function consumeUserToken<Row extends { tokenable_id: UserId }>(
  trx: Trx,
  config: UsersStorage,
  table: 'password_reset_tokens' | 'email_verification_tokens',
  token: string,
  validForUser: (row: Row, user: AccountUser) => boolean
): Promise<{ row: Row; user: AccountUser }> {
  return consumeUserTokenHash(trx, config, table, hashToken(token), validForUser)
}

/** Consume a hash already bound to a one-use server-side social transaction. */
export async function consumeUserTokenHash<Row extends { tokenable_id: UserId }>(
  trx: Trx,
  config: UsersStorage,
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
