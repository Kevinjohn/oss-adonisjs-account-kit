import { performance } from 'node:perf_hooks'
import type { Database } from '@adonisjs/lucid/database'
import type { Trx, UserId } from './types.js'

const SQLITE_RETRY_MS = 10
const SQLITE_DEADLINE_MS = 5000

function isBusy(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error.code === 'SQLITE_BUSY' || error.code === 'SQLITE_BUSY_SNAPSHOT')
  )
}

export function isUniqueViolation(error: unknown, table: string, column: string): boolean {
  if (typeof error !== 'object' || error === null) return false

  const details = error as { code?: unknown; constraint?: unknown; message?: unknown }
  if (details.code === '23505') {
    return details.constraint === `${table}_${column}_unique`
  }

  return (
    details.code === 'SQLITE_CONSTRAINT_UNIQUE' &&
    typeof details.message === 'string' &&
    details.message.includes(`${table}.${column}`)
  )
}

export async function lockUser(trx: Trx, id: UserId): Promise<void> {
  if (trx.dialect.name !== 'better-sqlite3') return
  await trx.rawQuery('update users set id = id where id = ?', [id]).exec()
}

/** Run a database-only callback; callers perform notifications after this resolves. */
export async function transaction<T>(db: Database, callback: (trx: Trx) => Promise<T>): Promise<T> {
  if (db.config.connections[db.primaryConnectionName].client !== 'better-sqlite3') {
    return db.transaction(callback)
  }

  const deadline = performance.now() + SQLITE_DEADLINE_MS
  for (;;) {
    try {
      return await db.transaction(async (trx) => {
        const timeoutResult = await trx.rawQuery('PRAGMA busy_timeout').exec()
        const timeout = Number(timeoutResult[0].timeout)
        await trx.rawQuery('PRAGMA busy_timeout = 0').exec()
        try {
          return await callback(trx)
        } finally {
          await trx.rawQuery(`PRAGMA busy_timeout = ${timeout}`).exec()
        }
      })
    } catch (error) {
      if (!isBusy(error) || performance.now() >= deadline) throw error
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(SQLITE_RETRY_MS, Math.max(0, deadline - performance.now())))
      )
    }
  }
}
