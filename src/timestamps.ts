import { RuntimeException } from '@adonisjs/core/exceptions'
// Converts timestamps between Luxon and the values SQL drivers accept and return.
import { DateTime } from 'luxon'

/** Anything that can say which SQL dialect it talks to: a query client, transaction or database. */
export type DialectSource =
  | { dialect: { name: string } }
  | {
      /** The connection whose dialect is read, as on a Lucid database. */
      connection(): { dialect: { name: string } }
    }

function getDatabaseDialect(client: DialectSource): string {
  return 'dialect' in client ? client.dialect.name : client.connection().dialect.name
}

/**
 * The value to write or compare for a timestamp column, in UTC. MySQL rejects ISO 8601 offsets
 * such as `Z`, so it gets `yyyy-MM-dd HH:mm:ss.SSS`; other engines get ISO 8601.
 *
 * @example
 * ```ts
 * import { DateTime } from 'luxon'
 * import { sqlTimestamp } from '@kevinjohn/adonisjs-account-kit/transaction'
 *
 * const recordedAt = sqlTimestamp(trx, DateTime.utc())
 * await trx.table('audit_events').insert({ recorded_at: recordedAt })
 * ```
 */
export function sqlTimestamp(client: DialectSource, at: DateTime): string {
  const utc = at.toUTC()
  if (!utc.isValid) throw new RuntimeException('account_kit: invalid timestamp')
  return getDatabaseDialect(client) === 'mysql'
    ? utc.toFormat('yyyy-MM-dd HH:mm:ss.SSS')
    : utc.toISO()!
}

/**
 * Read a timestamp column whatever the driver returns: a Date, a string or epoch milliseconds.
 *
 * @example
 * ```ts
 * import { readTimestamp } from '@kevinjohn/adonisjs-account-kit/transaction'
 *
 * const recordedAt = readTimestamp(row.recorded_at)?.toISO()
 * ```
 */
export function readTimestamp(value: unknown): DateTime | null {
  if (value === null || value === undefined) return null
  let parsed: DateTime
  if (value instanceof Date) parsed = DateTime.fromJSDate(value, { zone: 'utc' })
  else if (typeof value === 'number') parsed = DateTime.fromMillis(value, { zone: 'utc' })
  else if (typeof value === 'string') {
    parsed = DateTime.fromISO(value, { zone: 'utc' })
    if (!parsed.isValid) parsed = DateTime.fromSQL(value, { zone: 'utc' })
  } else throw new RuntimeException('account_kit: unreadable timestamp value')
  if (!parsed.isValid) throw new RuntimeException('account_kit: unreadable timestamp value')
  return parsed
}

/** Read a timestamp column as ISO 8601 UTC, whatever the driver returns. */
export function readIsoTimestamp(value: unknown): string | null {
  return readTimestamp(value)?.toUTC().toISO() ?? null
}
