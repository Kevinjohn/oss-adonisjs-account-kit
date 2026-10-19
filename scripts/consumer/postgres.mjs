// Prepares the dedicated PostgreSQL database that consumer runs own.
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { database, secret } from './settings.mjs'

/** A client for one database on the consumer server, loaded from the app's own `pg`. */
export function pgClient(appRoot, databaseName) {
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

export async function resetExclusivePostgresSchema(appRoot) {
  if (database !== 'postgres') return
  const databaseName = process.env.DB_DATABASE ?? 'account_kit_consumer'
  if (databaseName !== 'account_kit_consumer') {
    throw new Error(
      'PostgreSQL consumer runs only reset the dedicated account_kit_consumer database'
    )
  }
  const client = pgClient(appRoot, databaseName)
  await client.connect()
  await client.query('DROP SCHEMA public CASCADE')
  await client.query('CREATE SCHEMA public')
  await client.end()
}

export async function ensureExclusivePostgresDatabase(appRoot) {
  if (database !== 'postgres') return
  const databaseName = process.env.DB_DATABASE ?? 'account_kit_consumer'
  if (databaseName !== 'account_kit_consumer') {
    throw new Error('PostgreSQL consumer runs require the dedicated account_kit_consumer database')
  }
  const client = pgClient(appRoot, 'postgres')
  await client.connect()
  try {
    const existing = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [
      databaseName,
    ])
    if (existing.rowCount === 0) await client.query('CREATE DATABASE account_kit_consumer')
  } finally {
    await client.end()
  }
}
