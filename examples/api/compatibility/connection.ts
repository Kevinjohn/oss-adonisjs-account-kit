import { createRequire } from 'node:module'

/** Database connection settings for the minimum-compatibility consumer. */
export const databaseClient = process.env.DB_CONNECTION === 'pg' ? 'pg' : 'better-sqlite3'
export const databaseName = process.env.DB_CONNECTION === 'pg' ? 'postgres' : 'sqlite'
const require = createRequire(import.meta.url)
interface NativeSqliteConnection {
  readonly inTransaction: boolean
  exec(sql: string): void
  close(): void
  pragma(sql: string): unknown
}
export const NativeSqlite = require('better-sqlite3') as new (
  filename: string
) => NativeSqliteConnection
export const sqliteConnection = {
  client: 'better-sqlite3' as const,
  connection: { filename: 'compatibility.sqlite' },
  useNullAsDefault: true,
  pool: {
    min: 1,
    max: 1,
    afterCreate(
      connection: { pragma(sql: string): void },
      done: (error: Error | null, connection?: unknown) => void
    ) {
      connection.pragma('foreign_keys = ON')
      connection.pragma('busy_timeout = 1000')
      done(null, connection)
    },
  },
}
export const postgresConnection = {
  client: 'pg' as const,
  connection: {
    host: process.env.DB_HOST ?? '127.0.0.1',
    port: Number(process.env.DB_PORT ?? '55432'),
    user: process.env.DB_USER ?? 'account_kit',
    password: process.env.DB_PASSWORD ?? '',
    database: process.env.DB_DATABASE ?? 'account_kit_consumer',
  },
  pool: { min: 1, max: 4 },
}
