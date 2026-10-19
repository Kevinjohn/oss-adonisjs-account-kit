// Users table metadata and row locks taken before credential changes.
import { isSqlIdentifier } from './sql_identifier.js'
import type { ResolvedConfig, Trx, UserId, UsersAdapterMetadata } from './types.js'

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
