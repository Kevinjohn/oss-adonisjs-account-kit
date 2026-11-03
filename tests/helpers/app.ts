import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { IgnitorFactory } from '@adonisjs/core/factories'
import { Encryption } from '@adonisjs/core/encryption'
import { defineConfig as defineHashConfig, drivers as hashDrivers } from '@adonisjs/core/hash'
import type { Group } from '@japa/runner/core'
import { defineConfig as defineLimiterConfig, stores } from '@adonisjs/limiter'
import { defineConfig as defineDatabaseConfig } from '@adonisjs/lucid'
import type { Database } from '@adonisjs/lucid/database'
import type { ApplicationService } from '@adonisjs/core/types'
import { Hash } from '@adonisjs/core/hash'
import type { LimiterService } from '@adonisjs/limiter/types'
import { clearRows, resetSchema } from './schema.js'
import { dropPostgresFixtureSchema, testClient, testConnection } from './test_connection.js'

export interface TestApp {
  app: ApplicationService
  db: Database
  hash: Hash
  encryption: Encryption
  limiter: LimiterService
  appRootPath: string
  migrationDirectory: string
  close(): Promise<void>
}

export interface BootOptions {
  sqliteBusyTimeout?: number
  sqlitePoolMax?: number
  accountKitProvider?: 'source' | 'build'
  postgresSchema?: string
}

export async function bootTestApp(options: BootOptions = {}): Promise<TestApp> {
  const client = testClient()
  const sqliteDirectory =
    client === 'better-sqlite3' ? await mkdtemp(join(tmpdir(), 'account-kit-')) : null
  const sqliteFilename = sqliteDirectory ? join(sqliteDirectory, 'test.sqlite') : undefined
  const appRootPath = fileURLToPath(new URL('../..', import.meta.url))
  const migrationDirectory = await mkdtemp(join(tmpdir(), 'account-kit-migrations-'))
  let postgresSchemaCreated = false

  const connection = testConnection(client, {
    migrationDirectory,
    sqliteFilename,
    sqliteBusyTimeout: options.sqliteBusyTimeout,
    sqlitePoolMax: options.sqlitePoolMax,
    postgresSchema: options.postgresSchema,
    onPostgresSchemaCreated() {
      postgresSchemaCreated = true
    },
  })

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
              ? [() => import('@kevinjohn/adonisjs-account-kit/account_kit_provider')]
              : []),
        ],
      },
      config: {
        database: defineDatabaseConfig({ connection: 'test', connections: { test: connection } }),
        limiter: defineLimiterConfig({ default: 'memory', stores: { memory: stores.memory({}) } }),
        // Tests hash many passwords; nothing checks hash strength.
        hash: defineHashConfig({
          default: 'scrypt',
          list: { scrypt: hashDrivers.scrypt({ cost: 2 }) },
        }),
      },
    })

  const ignitor = factory.create(new URL(`file://${appRootPath}/`))
  const app = ignitor.createApp('console')

  try {
    await app.init()
    await app.boot()
    const db = await app.container.make('lucid.db')
    const hash = await app.container.make(Hash)
    const encryption = await app.container.make(Encryption)
    const limiter = await app.container.make('limiter.manager')
    if (sqliteFilename) {
      await db.connection().rawQuery('PRAGMA journal_mode = WAL').exec()
    }

    return {
      app,
      db,
      hash,
      encryption,
      limiter,
      appRootPath,
      migrationDirectory,
      async close() {
        try {
          if (options.postgresSchema && postgresSchemaCreated) {
            await dropPostgresFixtureSchema(options.postgresSchema)
          }
        } finally {
          try {
            await ignitor.terminate()
          } finally {
            if (sqliteDirectory) await rm(sqliteDirectory, { recursive: true, force: true })
            await rm(migrationDirectory, { recursive: true, force: true })
          }
        }
      },
    }
  } catch (error) {
    let failure: unknown = error
    try {
      if (options.postgresSchema && postgresSchemaCreated) {
        await dropPostgresFixtureSchema(options.postgresSchema)
      }
    } catch (cleanupError) {
      failure = new AggregateError(
        [error, cleanupError],
        'Test app startup and fixture cleanup failed'
      )
    } finally {
      try {
        await ignitor.terminate()
      } catch (terminationError) {
        failure = new AggregateError(
          [failure, terminationError],
          'Test app startup and termination failed'
        )
      } finally {
        if (sqliteDirectory) await rm(sqliteDirectory, { recursive: true, force: true })
        await rm(migrationDirectory, { recursive: true, force: true })
      }
    }
    throw failure
  }
}

/**
 * Boot one app and migrate the schema per group, then empty the tables and the limiter before
 * each test. The returned object is filled in by the group setup hook.
 */
export function useTestApp(group: Group, options: BootOptions = {}): TestApp {
  const kit = {} as TestApp
  group.setup(async () => {
    Object.assign(kit, await bootTestApp(options))
    await resetSchema(kit)
  })
  group.each.setup(async () => {
    await clearRows(kit)
    await kit.limiter.clear()
  })
  group.teardown(async () => {
    await kit.close()
  })
  return kit
}
