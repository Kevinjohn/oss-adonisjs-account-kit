// Unique-violation detection: recognising duplicate-key errors across MySQL, PostgreSQL and SQLite.
import type { Database } from '@adonisjs/lucid/database'
import { userMetadata, type UsersStorage } from './user_lock.js'

/** The `table.index` a MySQL duplicate-key error names, or undefined for any other error. */
export function mysqlDuplicateKey(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const details = error as { code?: unknown; sqlMessage?: unknown }
  if (details.code !== 'ER_DUP_ENTRY' || typeof details.sqlMessage !== 'string') return undefined
  // The duplicated value comes first and may itself contain the marker, so search from the end.
  const marker = " for key '"
  const start = details.sqlMessage.lastIndexOf(marker)
  if (start < 0 || !details.sqlMessage.endsWith("'")) return undefined
  return details.sqlMessage.slice(start + marker.length, -1)
}

export function isUniqueViolation(error: unknown, table: string, column: string): boolean {
  if (typeof error !== 'object' || error === null) return false
  const mysqlKey = mysqlDuplicateKey(error)
  if (mysqlKey !== undefined) return mysqlKey === `${table}.${table}_${column}_unique`

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

/** Identify only the actual unique email index; unrelated unique failures retain their identity. */
export async function isUserEmailUniqueViolation(
  error: unknown,
  config: UsersStorage,
  db: Database
): Promise<boolean> {
  if (!error || typeof error !== 'object') return false
  const details = error as { code?: string; constraint?: string }
  const mysqlKey = mysqlDuplicateKey(error)
  if (mysqlKey !== undefined) return isMysqlEmailKey(mysqlKey, config, db)
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

/** MySQL names the key as `table.index`; the index must be the users table's unique email index. */
async function isMysqlEmailKey(key: string, config: UsersStorage, db: Database): Promise<boolean> {
  const metadata = await userMetadata(config)
  const prefix = `${metadata.table}.`
  if (!key.startsWith(prefix)) return false
  const index = key.slice(prefix.length)
  const explicit = config.emailConstraint ?? metadata.emailConstraint
  if (explicit !== undefined) return index === explicit
  const [rows] = (await db.rawQuery(
    `select index_name as name
       from information_schema.statistics
      where table_schema = database() and table_name = ? and non_unique = 0
      group by index_name
     having count(*) = 1 and max(column_name) = 'email' and max(expression) is null`,
    [metadata.table]
  )) as [Array<{ name: string }>]
  return rows.some((row) => row.name === index)
}
