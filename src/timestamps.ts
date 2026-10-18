// Converts timestamps between Luxon and the values SQL drivers accept and return.
import { DateTime } from 'luxon'

/** The value to write for a timestamp column: an ISO 8601 UTC string. */
export function sqlTimestamp(at: DateTime): string {
  const value = at.toUTC().toISO()
  if (!value) throw new Error('account_kit: invalid timestamp')
  return value
}

/** Read a timestamp column whatever the driver returns: a Date, a string or epoch milliseconds. */
export function readTimestamp(value: unknown): DateTime | null {
  if (value === null || value === undefined) return null
  let parsed: DateTime
  if (value instanceof Date) parsed = DateTime.fromJSDate(value, { zone: 'utc' })
  else if (typeof value === 'number') parsed = DateTime.fromMillis(value, { zone: 'utc' })
  else if (typeof value === 'string') {
    parsed = DateTime.fromISO(value, { zone: 'utc' })
    if (!parsed.isValid) parsed = DateTime.fromSQL(value, { zone: 'utc' })
  } else throw new Error('account_kit: unreadable timestamp value')
  if (!parsed.isValid) throw new Error('account_kit: unreadable timestamp value')
  return parsed.toUTC()
}
