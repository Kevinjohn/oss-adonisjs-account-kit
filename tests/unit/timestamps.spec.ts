import { test } from '@japa/runner'
import { DateTime } from 'luxon'
import { sqlTimestamp } from '../../src/timestamps.js'

const engine = (name: string) => ({ dialect: { name } })

test.group('SQL timestamps', () => {
  test('MySQL gets UTC SQL format with milliseconds; other engines get ISO 8601', ({ assert }) => {
    const at = DateTime.fromISO('2026-03-04T06:06:07.089+01:00', { setZone: true })
    assert.equal(sqlTimestamp(engine('mysql'), at), '2026-03-04 05:06:07.089')
    assert.equal(sqlTimestamp(engine('pg'), at), '2026-03-04T05:06:07.089Z')
    assert.equal(sqlTimestamp(engine('better-sqlite3'), at), '2026-03-04T05:06:07.089Z')
  })

  test('reads the dialect from a database and defaults to now', ({ assert }) => {
    const database = { connection: () => engine('mysql') }
    const before = DateTime.utc().startOf('second')
    const value = DateTime.fromSQL(sqlTimestamp(database), { zone: 'utc' })
    assert.isTrue(value.isValid)
    assert.isAtLeast(value.toMillis(), before.toMillis())
  })

  test('rejects an invalid timestamp', ({ assert }) => {
    assert.throws(
      () => sqlTimestamp(engine('mysql'), DateTime.invalid('test')),
      /invalid timestamp/
    )
  })
})
