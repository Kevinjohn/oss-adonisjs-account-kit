// Deletes single-use rows and returns them, on engines with and without DELETE ... RETURNING.
import type { Database } from '@adonisjs/lucid/database'
import type { Trx } from './types.js'

/**
 * Run a `delete ... returning` statement and return the deleted rows. better-sqlite3 returns the
 * rows directly; pg wraps them in a result object.
 */
export async function deleteReturning<Row>(
  client: Trx | Database,
  sql: string,
  bindings: unknown[]
): Promise<Row[]> {
  const result: unknown = await client.rawQuery(sql, bindings).exec()
  return (Array.isArray(result) ? result : (result as { rows: Row[] }).rows) as Row[]
}

/** The number of rows a delete removed, whatever shape the driver reports it in. */
export function deletedCount(result: unknown): number {
  return Number(Array.isArray(result) ? result[0] : result)
}

/**
 * Delete the rows of `table` that match `where` and expire after `after`, and return them.
 * PostgreSQL and SQLite use `delete ... returning`. MySQL has no RETURNING, so it locks the rows
 * with `select ... for update` and deletes them by id in the same transaction. Column names are
 * package constants, never input.
 */
export async function consumeRows<Row>(
  trx: Trx,
  table: string,
  where: Record<string, string | number>,
  after: string
): Promise<Row[]> {
  const columns = Object.keys(where)
  if (trx.dialect.name !== 'mysql')
    return deleteReturning<Row>(
      trx,
      `delete from ${table} where ${columns.map((column) => `${column} = ?`).join(' and ')} and expires_at > ? returning *`,
      [...Object.values(where), after]
    )
  const rows: Array<Row & { id: number }> = await trx
    .from(table)
    .where(where)
    .where('expires_at', '>', after)
    .forUpdate()
  if (rows.length === 0) return []
  const deleted = await trx
    .from(table)
    .whereIn(
      'id',
      rows.map((row) => row.id)
    )
    .delete()
  if (deletedCount(deleted) !== rows.length)
    throw new Error(`account_kit: ${table} rows changed while they were consumed`)
  return rows
}
