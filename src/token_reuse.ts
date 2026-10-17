// Decides whether a matching email token was issued recently enough to suppress a resend.
import { DateTime } from 'luxon'

/** A matching, unexpired token younger than this is reused instead of reissued. */
export const RESEND_WINDOW = { minutes: 1 }

export interface IssuedTokenRow {
  purpose: unknown
  email: unknown
  current_email: unknown
  created_at: string | number | Date
  expires_at: string | number | Date
}

export interface ExpectedToken {
  purpose: string
  email: string
  currentEmail: string
}

/**
 * True when `row` has the expected purpose, target email and current email, has not expired, and
 * was created inside `RESEND_WINDOW`. Callers pass what they expect so each site keeps its own
 * accept set.
 */
export function isRecentIssue(
  row: IssuedTokenRow | null | undefined,
  expected: ExpectedToken,
  now: DateTime
): boolean {
  return (
    row?.purpose === expected.purpose &&
    row.email === expected.email &&
    row.current_email === expected.currentEmail &&
    DateTime.fromJSDate(new Date(row.expires_at)).toMillis() > now.toMillis() &&
    DateTime.fromJSDate(new Date(row.created_at)).toMillis() > now.minus(RESEND_WINDOW).toMillis()
  )
}
