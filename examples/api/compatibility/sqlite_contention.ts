import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import type { AccountKit } from 'adonisjs-account-kit'
import type dbService from '@adonisjs/lucid/services/db'
import type UserModel from './user.js'
import type { NativeSqlite } from './connection.js'

type User = InstanceType<typeof UserModel>
type Database = typeof dbService
type SqliteConstructor = typeof NativeSqlite
type ContentionContext = {
  account: AccountKit
  db: Database
  profile: User
  NativeSqlite: SqliteConstructor
  databaseName: string
}

export async function runSqliteContention({
  account,
  db,
  profile,
  NativeSqlite,
  databaseName,
}: ContentionContext) {
  if (databaseName === 'sqlite') {
    const writer = new NativeSqlite('compatibility.sqlite')
    writer.pragma('busy_timeout = 0')
    writer.exec('BEGIN IMMEDIATE')
    let busyLockAttempts = 0
    const sqliteClient = db.connection().getWriteClient().client
    const countBusyLockAttempt = (query: { sql?: string }) => {
      if (/^update account_transaction_lock/i.test(query.sql ?? '')) busyLockAttempts += 1
    }
    sqliteClient.on('query', countBusyLockAttempt)
    const startedAt = performance.now()
    const releaseWriter = setTimeout(() => {
      if (writer.inTransaction) writer.exec('COMMIT')
      writer.close()
    }, 60)
    try {
      await account.passwordReset.request({
        email: profile.email,
        clientKey: 'sqlite-retry-client',
      })
    } finally {
      clearTimeout(releaseWriter)
      if (writer.inTransaction) writer.exec('COMMIT')
      writer.close()
      sqliteClient.off('query', countBusyLockAttempt)
    }
    const elapsedMs = Math.round(performance.now() - startedAt)
    assert.ok(busyLockAttempts >= 2, `expected a busy lock retry, observed ${busyLockAttempts}`)
    assert.ok(
      elapsedMs >= 40,
      `expected the writer lock to delay the operation, observed ${elapsedMs}ms`
    )
    console.log(
      `MINIMUM_SQLITE_RETRY_SMOKE ${JSON.stringify({ elapsedMs, busyLockAttempts, lockReleasedAfterMs: 60 })}`
    )
  }
}
