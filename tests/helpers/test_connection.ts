export type TestClient = 'pg' | 'mysql2' | 'better-sqlite3'

/** The database client under test, from `DB_CLIENT`. */
export function testClient(): TestClient {
  const client = process.env.DB_CLIENT ?? 'better-sqlite3'
  if (client !== 'pg' && client !== 'mysql2' && client !== 'better-sqlite3') {
    throw new Error(`Unsupported DB_CLIENT: ${client}`)
  }
  return client
}

export interface TestConnectionOptions {
  migrationDirectory: string
  sqliteFilename?: string
  sqliteBusyTimeout?: number
  sqlitePoolMax?: number
}

/** The Lucid connection config for the client under test. */
export function testConnection(client: TestClient, options: TestConnectionOptions) {
  const { migrationDirectory, sqliteFilename } = options
  return client === 'pg'
    ? {
        client: 'pg' as const,
        connection: {
          host: process.env.DB_HOST ?? '127.0.0.1',
          port: Number(process.env.DB_PORT ?? 55432),
          user: process.env.DB_USER ?? 'account_kit',
          password: process.env.DB_PASSWORD ?? '',
          database: process.env.DB_DATABASE ?? 'account_kit_test',
        },
        pool: { min: 1, max: 4 },
        migrations: { paths: [migrationDirectory] },
      }
    : client === 'mysql2'
      ? {
          client: 'mysql2' as const,
          connection: {
            host: process.env.DB_HOST ?? '127.0.0.1',
            port: Number(process.env.DB_PORT ?? 33306),
            user: process.env.DB_USER ?? 'root',
            password: process.env.DB_PASSWORD ?? '',
            database: process.env.DB_DATABASE ?? 'account_kit_test',
            timezone: 'Z',
          },
          pool: {
            min: 1,
            max: 4,
            afterCreate(
              mysql: { query(sql: string, done: (error: Error | null) => void): void },
              done: (error: Error | null, connection: unknown) => void
            ) {
              mysql.query("set time_zone = '+00:00'", (error) => done(error, mysql))
            },
          },
          migrations: { paths: [migrationDirectory] },
        }
      : {
          client: 'better-sqlite3' as const,
          connection: { filename: sqliteFilename! },
          useNullAsDefault: true,
          pool: {
            min: 1,
            max: options.sqlitePoolMax ?? 4,
            afterCreate(
              sqlite: { pragma(query: string): unknown },
              done: (error: Error | null, connection: unknown) => void
            ) {
              sqlite.pragma(`busy_timeout = ${options.sqliteBusyTimeout ?? 5000}`)
              sqlite.pragma('foreign_keys = ON')
              done(null, sqlite)
            },
          },
          migrations: { paths: [migrationDirectory] },
        }
}
