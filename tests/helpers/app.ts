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

export interface TestApp {
  app: ApplicationService
  db: Database
  hash: Hash
  limiter: { clear(): Promise<void> }
  close(): Promise<void>
}

export async function bootTestApp(): Promise<TestApp> {
  const client = process.env.DB_CLIENT ?? 'better-sqlite3'
  if (client !== 'pg' && client !== 'better-sqlite3') {
    throw new Error(`Unsupported DB_CLIENT: ${client}`)
  }
  const sqliteDirectory =
    client === 'better-sqlite3' ? await mkdtemp(join(tmpdir(), 'account-kit-')) : null
  const sqliteFilename = sqliteDirectory ? join(sqliteDirectory, 'test.sqlite') : undefined

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
        }
      : {
          client: 'better-sqlite3' as const,
          connection: { filename: sqliteFilename! },
          useNullAsDefault: true,
          pool: {
            min: 1,
            max: 4,
            afterCreate(
              sqlite: { pragma(query: string): unknown },
              done: (error: Error | null, connection: unknown) => void
            ) {
              sqlite.pragma('busy_timeout = 5000')
              done(null, sqlite)
            },
          },
        }

  const factory = new IgnitorFactory()
    .withCoreProviders()
    .withCoreConfig()
    .merge({
      rcFileContents: {
        providers: [
          () => import('@adonisjs/lucid/database_provider'),
          () => import('@adonisjs/limiter/limiter_provider'),
        ],
      },
      config: {
        database: defineDatabaseConfig({ connection: 'test', connections: { test: connection } }),
        limiter: defineLimiterConfig({ default: 'memory', stores: { memory: stores.memory({}) } }),
      },
    })

  const ignitor = factory.create(
    new URL(`file://${fileURLToPath(new URL('../..', import.meta.url))}/`)
  )
  const app = ignitor.createApp('console')

  try {
    await app.init()
    await app.boot()
    const db = await app.container.make('lucid.db')
    const hash = await app.container.make(Hash)
    const limiter = await app.container.make('limiter.manager')
    if (sqliteFilename) {
      await db.connection().raw('PRAGMA journal_mode = WAL')
      await db.connection().raw('PRAGMA busy_timeout = 5000')
    }

    return {
      app,
      db,
      hash,
      limiter,
      async close() {
        await ignitor.terminate()
        if (sqliteDirectory) await rm(sqliteDirectory, { recursive: true, force: true })
      },
    }
  } catch (error) {
    await ignitor.terminate()
    if (sqliteDirectory) await rm(sqliteDirectory, { recursive: true, force: true })
    throw error
  }
}
