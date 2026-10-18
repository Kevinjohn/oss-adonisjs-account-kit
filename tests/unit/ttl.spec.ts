import { DateTime } from 'luxon'
import { test } from '@japa/runner'
import { expiresAt } from '../../src/ttl.js'

test.group('expiration helper', () => {
  test('adds parsed TTL seconds to a DateTime', async ({ assert }) => {
    const now = DateTime.utc(2026, 1, 2, 3, 4, 5)
    assert.equal(expiresAt(now, '1h').toMillis(), now.plus({ hours: 1 }).toMillis())
    assert.equal(expiresAt(now, '7d').toMillis(), now.plus({ days: 7 }).toMillis())
    assert.equal(expiresAt(now, 3600).toMillis(), expiresAt(now, '1h').toMillis())
    assert.equal(expiresAt(now, 1.5).toMillis(), now.plus({ seconds: 1.5 }).toMillis())
  })

  test('rejects non-positive and unparseable TTL values', async ({ assert }) => {
    const now = DateTime.utc()
    assert.throws(() => expiresAt(now, '0s'))
    assert.throws(() => expiresAt(now, 'soon'))
    assert.throws(() => expiresAt(now, '100000000000000000000d'))
    for (const seconds of [
      0,
      -1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      assert.throws(() => expiresAt(now, seconds))
    }
  })
})
