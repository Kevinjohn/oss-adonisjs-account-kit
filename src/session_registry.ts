// Session sign-in registry: one row per signed-in browser session, keyed by a hashed handle.
import { DateTime } from 'luxon'
import { InvalidSessionError } from './errors.js'
import { generateToken, hashToken } from './tokens.js'
import { expiresAt } from './ttl.js'
import type { ResolvedConfig, Trx, UserId } from './types.js'
import { readIsoTimestamp, sqlTimestamp } from './timestamps.js'

export const sessionTable = 'account_sessions'

/** Seen sign-ins are refreshed at most this often, so idle expiry must be longer. */
export const sessionTouchIntervalMs = 5 * 60 * 1000

/** Session guards record each sign-in only while `sessionManagement` is enabled. */
export function sessionRegistryEnabled(config: ResolvedConfig): boolean {
  return (
    config.enabled.includes('sessionManagement') && config.authentication?.strategy === 'session'
  )
}

export function newSessionHandle(): string {
  return generateToken(32)
}

export async function recordSession(
  trx: Trx,
  config: ResolvedConfig,
  userId: UserId,
  handle: string,
  label: string | null
): Promise<void> {
  const now = DateTime.utc()
  await trx.table(sessionTable).insert({
    user_id: userId,
    handle_hash: hashToken(handle),
    label,
    created_at: sqlTimestamp(trx, now),
    last_seen_at: sqlTimestamp(trx, now),
    expires_at: sqlTimestamp(trx, expiresAt(now, config.sessionManagement.idleExpiry)),
  })
}

export interface LiveSession {
  id: number
  lastSeenAt: string
}

/** Require an unexpired registry row for this user and handle. A missing handle fails closed. */
export async function requireLiveSession(
  trx: Trx,
  userId: UserId,
  handle: string | undefined
): Promise<LiveSession> {
  if (typeof handle !== 'string' || handle === '') throw new InvalidSessionError()
  const row = await trx
    .from(sessionTable)
    .select('id', 'user_id', 'last_seen_at', 'expires_at')
    .where('handle_hash', hashToken(handle))
    .first()
  const now = DateTime.utc()
  if (
    !row ||
    String(row.user_id) !== String(userId) ||
    Date.parse(readIsoTimestamp(row.expires_at)!) <= now.toMillis()
  )
    throw new InvalidSessionError()
  return { id: row.id as number, lastSeenAt: readIsoTimestamp(row.last_seen_at)! }
}

/**
 * Extend a sign-in that was just accepted. Callers run this after every other check, so a rejected
 * request never refreshes a sign-in; it writes at most once per touch interval.
 */
export async function touchSession(
  trx: Trx,
  config: ResolvedConfig,
  session: LiveSession
): Promise<void> {
  const now = DateTime.utc()
  if (now.toMillis() - Date.parse(session.lastSeenAt) < sessionTouchIntervalMs) return
  await trx
    .from(sessionTable)
    .where('id', session.id)
    .update({
      last_seen_at: sqlTimestamp(trx, now),
      expires_at: sqlTimestamp(trx, expiresAt(now, config.sessionManagement.idleExpiry)),
    })
}
