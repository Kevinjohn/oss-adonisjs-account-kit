import assert from 'node:assert/strict'
import { IgnitorFactory } from '@adonisjs/core/factories'
import { defineConfig as defineDatabaseConfig } from '@adonisjs/lucid'
import { databaseClient, postgresConnection, sqliteConnection } from './connection.js'

/**
 * Mirrors `node ace migration:run --force` in a consumer on the exact Core floor. Ace loads every
 * registered command collection before the requested command runs, so the package's command
 * modules must import only what the floor exports.
 */
const factory = new IgnitorFactory()
  .withCoreProviders()
  .withCoreConfig()
  .merge({
    rcFileContents: {
      commands: [
        () => import('@adonisjs/lucid/commands'),
        () => import('adonisjs-account-kit/commands'),
        () => import('adonisjs-account-kit/admission/commands'),
      ],
      providers: [() => import('@adonisjs/lucid/database_provider')],
    },
    config: {
      database: defineDatabaseConfig({
        connection: 'consumer',
        connections: {
          consumer: databaseClient === 'pg' ? postgresConnection : sqliteConnection,
        },
      }),
    },
  })

const ignitor = factory.create(new URL('./', import.meta.url))
await ignitor.ace().handle(['migration:run', '--force'])
assert.equal(process.exitCode ?? 0, 0, 'migration:run failed on the Core floor')
console.log('MINIMUM_STAGE ace-migration-run')
