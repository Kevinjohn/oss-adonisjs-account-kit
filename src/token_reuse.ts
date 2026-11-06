// Decides whether a matching email token was issued recently enough to suppress a resend.
import { DateTime } from 'luxon'
import type { Database } from '@adonisjs/lucid/database'
import { readTimestamp, sqlTimestamp } from './timestamps.js'
import { hashToken } from './tokens.js'

/** A matching, unexpired token younger than this is reused instead of reissued. */
export const RESEND_WINDOW = { minutes: 1 }

export interface IssuedTokenRow {
  purpose: unknown
  email: unknown
  current_email: unknown
  created_at: unknown
  expires_at: unknown
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
    readTimestamp(row.expires_at)!.toMillis() > now.toMillis() &&
    readTimestamp(row.created_at)!.toMillis() > now.minus(RESEND_WINDOW).toMillis()
  )
}

/**
 * Runs `send`; when it fails, moves the token's issue time out of `RESEND_WINDOW`, so a retry
 * issues and sends a new link instead of reporting the undelivered one as sent.
 */
export async function reopenResendOnFailure(
  db: Database,
  token: string,
  send: () => Promise<void>
): Promise<void> {
  try {
    await send()
  } catch (error) {
    await db
      .from('email_verification_tokens')
      .where('hash', hashToken(token))
      .update({ created_at: sqlTimestamp(db, DateTime.utc().minus(RESEND_WINDOW)) })
      .catch(() => {})
    throw error
  }
}
