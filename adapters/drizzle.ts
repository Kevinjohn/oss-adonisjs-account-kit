import type { SqlUsersAdapter, SqlUsersAdapterOptions } from './sql.js'
import { deferredSqlUsersAdapter } from '../src/deferred_sql_adapter.js'
import { canonicalUserColumns } from '../src/user_columns.js'

export type { SqlUsersAdapter, SqlUsersAdapterOptions } from './sql.js'

export type DrizzleAdapterOptions = Omit<SqlUsersAdapterOptions, 'table'>

type DrizzleColumn = { name?: unknown; columnType?: unknown }

const nameKey = Symbol.for('drizzle:Name')
const schemaKey = Symbol.for('drizzle:Schema')
const columnsKey = Symbol.for('drizzle:Columns')

/** Read the physical table name from a Drizzle table and check its user columns. */
function drizzleUsersTable(usersTable: object): string {
  const table = usersTable as Record<symbol, unknown>
  const name = table[nameKey]
  const columns = table[columnsKey] as Record<string, DrizzleColumn> | undefined
  if (typeof name !== 'string' || !columns || typeof columns !== 'object')
    throw new Error('account_kit: createDrizzleAdapter expects a Drizzle table')
  if (table[schemaKey] !== undefined)
    throw new Error('account_kit: the Drizzle users table must be in the default schema')
  for (const [property, column] of canonicalUserColumns) {
    if (columns[property]?.name !== column)
      throw new Error(
        `account_kit: the Drizzle users table must map the ${property} property to the ${column} column`
      )
  }
  if (columns.emailVerifiedAt.columnType === 'SQLiteTimestamp')
    throw new Error(
      'account_kit: store email_verified_at as text on SQLite; integer-mode Drizzle timestamps are not supported'
    )
  return name
}

/**
 * A users adapter for a users table defined with Drizzle. It reads the table definition only;
 * every query runs through the package's Lucid transaction, so Drizzle runtime defaults such as
 * `$defaultFn` and `$onUpdate` do not run.
 */
export function createDrizzleAdapter(
  usersTable: object,
  options: DrizzleAdapterOptions = {}
): SqlUsersAdapter {
  return deferredSqlUsersAdapter(() => drizzleUsersTable(usersTable), options)
}
