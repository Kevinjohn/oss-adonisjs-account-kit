import { DateTime } from 'luxon'
import { sqlTimestamp } from '../../src/timestamps.js'
import type { TestApp } from './app.js'

/** A timestamp fixture value the test database accepts: ISO 8601 on SQLite and PostgreSQL, SQL format on MySQL. */
export function dbTime(kit: Pick<TestApp, 'db'>, at: string | DateTime = DateTime.utc()): string {
  return sqlTimestamp(kit.db, typeof at === 'string' ? DateTime.fromISO(at, { zone: 'utc' }) : at)
}
