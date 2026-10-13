import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { IgnitorFactory } from '@adonisjs/core/factories'
import { defineConfig as defineLimiterConfig, stores } from '@adonisjs/limiter'
import { defineConfig as defineDatabaseConfig } from '@adonisjs/lucid'
import type { Database } from '@adonisjs/lucid/database'
import type { ApplicationService } from '@adonisjs/core/types'
import { Hash } from '@adonisjs/core/hash'
import type { LimiterService } from '@adonisjs/limiter/types'

export interface TestApp {
  app: ApplicationService
  db: Database
  hash: Hash
  limiter: LimiterService
  appRootPath: string
  migrationDirectory: string
  close(): Promise<void>
}

export async function bootTestApp(
  options: {
    sqliteBusyTimeout?: number
    sqlitePoolMax?: number
    accountKitProvider?: 'source' | 'build'
  } = {}
): Promise<TestApp> {
  const client = process.env.DB_CLIENT ?? 'better-sqlite3'
  if (client !== 'pg' && client !== 'better-sqlite3') {
    throw new Error(`Unsupported DB_CLIENT: ${client}`)
  }
  const sqliteDirectory =
    client === 'better-sqlite3' ? await mkdtemp(join(tmpdir(), 'account-kit-')) : null
  const sqliteFilename = sqliteDirectory ? join(sqliteDirectory, 'test.sqlite') : undefined
  const appRootPath = fileURLToPath(new URL('../..', import.meta.url))
  const migrationDirectory = await mkdtemp(join(tmpdir(), 'account-kit-migrations-'))

  const connection =
    client === 'pg'
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

  const factory = new IgnitorFactory()
    .withCoreProviders()
    .withCoreConfig()
    .merge({
      rcFileContents: {
        providers: [
          () => import('@adonisjs/lucid/database_provider'),
          () => import('@adonisjs/limiter/limiter_provider'),
          ...(options.accountKitProvider === 'source'
            ? [() => import('../../providers/account_kit_provider.js')]
            : options.accountKitProvider === 'build'
              ? [() => import('adonisjs-account-kit/providers/account_kit_provider')]
              : []),
        ],
      },
      config: {
        database: defineDatabaseConfig({ connection: 'test', connections: { test: connection } }),
        limiter: defineLimiterConfig({ default: 'memory', stores: { memory: stores.memory({}) } }),
      },
    })

  const ignitor = factory.create(new URL(`file://${appRootPath}/`))
  const app = ignitor.createApp('console')

  try {
    await app.init()
    await app.boot()
    const db = await app.container.make('lucid.db')
    const hash = await app.container.make(Hash)
    const limiter = await app.container.make('limiter.manager')
    if (sqliteFilename) {
      await db.connection().raw('PRAGMA journal_mode = WAL')
    }

    return {
      app,
      db,
      hash,
      limiter,
      appRootPath,
      migrationDirectory,
      async close() {
        await ignitor.terminate()
        if (sqliteDirectory) await rm(sqliteDirectory, { recursive: true, force: true })
        await rm(migrationDirectory, { recursive: true, force: true })
      },
    }
  } catch (error) {
    await ignitor.terminate()
    if (sqliteDirectory) await rm(sqliteDirectory, { recursive: true, force: true })
    await rm(migrationDirectory, { recursive: true, force: true })
    throw error
  }
}
