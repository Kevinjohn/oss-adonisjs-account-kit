import { test } from '@japa/runner'
import { DateTime } from 'luxon'
import { isRecentIssue, RESEND_WINDOW } from '../../src/token_reuse.js'

const now = DateTime.utc(2026, 1, 1, 12, 0, 0)
const expected = { purpose: 'activation', email: 'a@example.test', currentEmail: 'a@example.test' }

function row(overrides: Record<string, unknown> = {}) {
  return {
    purpose: 'activation',
    email: 'a@example.test',
    current_email: 'a@example.test',
    created_at: now.minus({ seconds: 10 }).toJSDate(),
    expires_at: now.plus({ hours: 1 }).toJSDate(),
    ...overrides,
  } as Parameters<typeof isRecentIssue>[0]
}

test.group('recent token issue', () => {
  test('accepts a matching, unexpired token inside the window', ({ assert }) => {
    assert.isTrue(isRecentIssue(row(), expected, now))
  })

  test('uses a one minute window and rejects a token created exactly at its edge', ({ assert }) => {
    assert.deepEqual(RESEND_WINDOW, { minutes: 1 })
    const justInside = now.minus(RESEND_WINDOW).plus({ milliseconds: 1 }).toJSDate()
    const atEdge = now.minus(RESEND_WINDOW).toJSDate()
    assert.isTrue(isRecentIssue(row({ created_at: justInside }), expected, now))
    assert.isFalse(isRecentIssue(row({ created_at: atEdge }), expected, now))
  })

  test('rejects an expired token, including one expiring exactly now', ({ assert }) => {
    assert.isFalse(isRecentIssue(row({ expires_at: now.toJSDate() }), expected, now))
    assert.isFalse(
      isRecentIssue(row({ expires_at: now.minus({ seconds: 1 }).toJSDate() }), expected, now)
    )
  })

  test('rejects a mismatched purpose, email or current email', ({ assert }) => {
    assert.isFalse(isRecentIssue(row({ purpose: 'email_change' }), expected, now))
    assert.isFalse(isRecentIssue(row({ email: 'b@example.test' }), expected, now))
    assert.isFalse(isRecentIssue(row({ current_email: 'b@example.test' }), expected, now))
  })

  test('rejects a missing row and accepts string timestamps', ({ assert }) => {
    assert.isFalse(isRecentIssue(undefined, expected, now))
    assert.isFalse(isRecentIssue(null, expected, now))
    const iso = (value: DateTime) => value.toISO()!
    assert.isTrue(
      isRecentIssue(
        row({
          created_at: iso(now.minus({ seconds: 5 })),
          expires_at: iso(now.plus({ minutes: 5 })),
        }),
        expected,
        now
      )
    )
  })

  test('reads zoneless MySQL timestamps as UTC whatever the process time zone', ({
    assert,
    cleanup,
  }) => {
    const previous = process.env.TZ
    process.env.TZ = 'Asia/Tokyo'
    cleanup(() => {
      if (previous === undefined) delete process.env.TZ
      else process.env.TZ = previous
    })
    const mysql = (value: DateTime) => value.toUTC().toFormat('yyyy-MM-dd HH:mm:ss.SSS')
    assert.isTrue(
      isRecentIssue(
        row({
          created_at: mysql(now.minus({ seconds: 5 })),
          expires_at: mysql(now.plus({ minutes: 5 })),
        }),
        expected,
        now
      )
    )
  })
})
