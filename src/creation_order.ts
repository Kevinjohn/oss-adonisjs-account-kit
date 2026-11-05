// Keyset paging on (created_at, id) that compares instants, whatever text a SQLite row stores.
import { DateTime } from 'luxon'
import type { DatabaseQueryBuilderContract } from '@adonisjs/lucid/types/querybuilder'
import { sqlTimestamp, type DialectSource } from './timestamps.js'

function dialectOf(client: DialectSource): string {
  return 'dialect' in client ? client.dialect.name : client.connection().dialect.name
}

/**
 * SQLite stores timestamps as text, and rows written outside the package may use
 * `yyyy-MM-dd HH:mm:ss` instead of ISO 8601. `julianday` reads both as the same instant.
 */
const storesText = (client: DialectSource) =>
  ['better-sqlite3', 'sqlite3'].includes(dialectOf(client))

/** Order oldest first, then by id. */
export function orderByCreation(query: DatabaseQueryBuilderContract, client: DialectSource): void {
  if (storesText(client)) query.orderByRaw('julianday(created_at) asc')
  else query.orderBy('created_at', 'asc')
  query.orderBy('id', 'asc')
}

/** Keep rows after the cursor position in creation order. */
export function afterCreation(
  query: DatabaseQueryBuilderContract,
  client: DialectSource,
  position: { createdAt: string; id: number }
): void {
  const at = DateTime.fromISO(position.createdAt, { zone: 'utc' })
  if (storesText(client)) {
    const instant = at.toISO()!
    query.where((builder) =>
      builder
        .whereRaw('julianday(created_at) > julianday(?)', [instant])
        .orWhere((nested) =>
          nested
            .whereRaw('julianday(created_at) = julianday(?)', [instant])
            .where('id', '>', position.id)
        )
    )
    return
  }
  const createdAt = sqlTimestamp(client, at)
  query.where((builder) =>
    builder
      .where('created_at', '>', createdAt)
      .orWhere((nested) => nested.where('created_at', createdAt).where('id', '>', position.id))
  )
}
