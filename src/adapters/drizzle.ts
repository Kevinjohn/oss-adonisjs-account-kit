import type { DrizzleAdapterOptions } from '../types_sql_adapters.ts'
import type { SqlUsersAdapter } from './sql.ts'
import { E_ACCOUNT_KIT_INVALID_CONFIGURATION } from '../errors.ts'
import { createDeferredSqlUsersAdapter } from '../deferred_sql_adapter.ts'
import { canonicalUserColumns } from '../user_columns.ts'

export type { SqlUsersAdapter, SqlUsersAdapterOptions } from './sql.ts'

type DrizzleColumn = { name?: unknown; columnType?: unknown }

const nameKey = Symbol.for('drizzle:Name')
const schemaKey = Symbol.for('drizzle:Schema')
const columnsKey = Symbol.for('drizzle:Columns')

/** Read the physical table name from a Drizzle table and check its user columns. */
function requireDrizzleUsersTable(usersTable: object): string {
  const table = usersTable as Record<symbol, unknown>
  const name = table[nameKey]
  const columns = table[columnsKey] as Record<string, DrizzleColumn> | undefined
  if (typeof name !== 'string' || !columns || typeof columns !== 'object')
    throw new E_ACCOUNT_KIT_INVALID_CONFIGURATION(
      'usersTable',
      'account_kit: createDrizzleAdapter expects a Drizzle table'
    )
  if (table[schemaKey] !== undefined)
    throw new E_ACCOUNT_KIT_INVALID_CONFIGURATION(
      'usersTable.schema',
      'account_kit: the Drizzle users table must be in the default schema'
    )
  for (const [property, column] of canonicalUserColumns) {
    if (columns[property]?.name !== column)
      throw new E_ACCOUNT_KIT_INVALID_CONFIGURATION(
        `usersTable.columns.${property}`,
        `account_kit: the Drizzle users table must map the ${property} property to the ${column} column`
      )
  }
  if (columns.emailVerifiedAt.columnType === 'SQLiteTimestamp')
    throw new E_ACCOUNT_KIT_INVALID_CONFIGURATION(
      'usersTable.columns.emailVerifiedAt',
      'account_kit: store email_verified_at as text on SQLite; integer-mode Drizzle timestamps are not supported'
    )
  return name
}

/**
 * A users adapter for a users table defined with Drizzle. It reads the table definition only;
 * every query runs through the package's Lucid transaction, so Drizzle runtime defaults such as
 * `$defaultFn` and `$onUpdate` do not run.
 *
 * @example
 * ```ts
 * import { createDrizzleAdapter } from '@kevinjohn/adonisjs-account-kit/adapters/drizzle'
 * import { users as usersTable } from '#database/schema'
 *
 * const users = createDrizzleAdapter(usersTable)
 * ```
 */
export function createDrizzleAdapter(
  usersTable: object,
  options: DrizzleAdapterOptions = {}
): SqlUsersAdapter {
  return createDeferredSqlUsersAdapter(() => requireDrizzleUsersTable(usersTable), options)
}

export type { DrizzleAdapterOptions } from '../types_sql_adapters.ts'
