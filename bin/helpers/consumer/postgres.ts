// Prepares the dedicated PostgreSQL database that consumer runs own.
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { database, secret } from './settings.js'

/** A client for one database on the consumer server, loaded from the app's own `pg`. */
export function pgClient(appRoot: string, databaseName: string) {
  const require = createRequire(join(appRoot, 'package.json'))
  const { Client } = require('pg')
  return new Client({
    host: process.env.DB_HOST ?? '127.0.0.1',
    port: Number(process.env.DB_PORT ?? '55432'),
    user: process.env.DB_USER ?? 'account_kit',
    password: secret || undefined,
    database: databaseName,
  })
}

/** Owns shutdown, including a failed connect that may have allocated a socket.
 * Operation failures precede shutdown failures in AggregateError.errors.
 */
export async function withPostgresClient<T>(
  appRoot: string,
  databaseName: string,
  operation: (client: ReturnType<typeof pgClient>) => Promise<T>
): Promise<T> {
  const client = pgClient(appRoot, databaseName)
  let result: T
  let failed = false
  let failure: unknown
  try {
    await client.connect()
    result = await operation(client)
  } catch (error) {
    failed = true
    failure = error
  }
  try {
    await client.end()
  } catch (error) {
    if (failed) {
      throw new AggregateError([failure, error], 'PostgreSQL operation and shutdown failed')
    }
    throw error
  }
  if (failed) throw failure
  return result!
}

export async function resetExclusivePostgresSchema(appRoot: string) {
  if (database !== 'postgres') return
  const databaseName = process.env.DB_DATABASE ?? 'account_kit_consumer'
  if (databaseName !== 'account_kit_consumer') {
    throw new Error(
      'PostgreSQL consumer runs only reset the dedicated account_kit_consumer database'
    )
  }
  await withPostgresClient(appRoot, databaseName, async (client) => {
    await client.query('DROP SCHEMA public CASCADE')
    await client.query('CREATE SCHEMA public')
  })
}

export async function ensureExclusivePostgresDatabase(appRoot: string) {
  if (database !== 'postgres') return
  const databaseName = process.env.DB_DATABASE ?? 'account_kit_consumer'
  if (databaseName !== 'account_kit_consumer') {
    throw new Error('PostgreSQL consumer runs require the dedicated account_kit_consumer database')
  }
  await withPostgresClient(appRoot, 'postgres', async (client) => {
    const existing = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [
      databaseName,
    ])
    if (existing.rowCount === 0) await client.query('CREATE DATABASE account_kit_consumer')
  })
}
