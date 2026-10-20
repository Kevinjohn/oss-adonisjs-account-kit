// Credential revision: reading and advancing `credentials_changed_at`, and the credential-change transition.
import { DateTime } from 'luxon'
import { userMetadata } from './db.js'
import { clearSocialPending } from './credential_cleanup.js'
import { sessionTable } from './session_registry.js'
import { InvalidCredentialsError } from './errors.js'
import type { AccountUser, ChangePasswordInput, ResolvedConfig, Trx, UserId } from './types.js'
import { hashToken } from './tokens.js'
import { readIsoTimestamp } from './timestamps.js'

export async function revision(
  trx: Trx,
  config: ResolvedConfig,
  userId: UserId
): Promise<string | null> {
  const metadata = await userMetadata(config)
  const table = metadata.table
  const row = await trx.from(table).select('credentials_changed_at').where('id', userId).first()
  if (!row) throw new InvalidCredentialsError()
  return readIsoTimestamp(row.credentials_changed_at)
}

/** The caller's own sign-in that a self-service password change keeps. */
export type KeptCredential = ChangePasswordInput['keepCurrent']

/**
 * The account lock makes the revision advance even if two changes use the same wall-clock tick.
 * Every session and token ends except `keep`; a `keep` that matches nothing ends them all.
 */
export async function advanceCredentialRevision(
  trx: Trx,
  config: ResolvedConfig,
  userId: UserId,
  keep?: KeptCredential
): Promise<void> {
  const metadata = await userMetadata(config)
  const table = metadata.table
  const previous = await revision(trx, config, userId)
  const next = DateTime.fromMillis(Math.max(Date.now(), previous ? Date.parse(previous) + 1 : 0), {
    zone: 'utc',
  })
  // MySQL's dialect format drops milliseconds, which the revision needs.
  const value =
    trx.dialect.name === 'better-sqlite3' || trx.dialect.name === 'mysql'
      ? next.toFormat('yyyy-MM-dd HH:mm:ss.SSS')
      : next.toFormat(trx.dialect.dateTimeFormat)
  await trx.from(table).where('id', userId).update({ credentials_changed_at: value })
  if (config.authentication?.strategy === 'access_tokens') {
    const tokens = trx.from(config.authentication.tokenTable).where('tokenable_id', userId)
    if (keep?.tokenId !== undefined) tokens.whereNot('id', keep.tokenId)
    await tokens.delete()
  }
  // The registry table is installed for every application, so sessions end even while
  // sessionManagement is off.
  if (config.authentication) {
    const sessions = trx.from(sessionTable).where('user_id', userId)
    if (keep?.sessionHandle !== undefined)
      sessions.whereNot('handle_hash', hashToken(keep.sessionHandle))
    await sessions.delete()
  }
}

export async function credentialsChanged(
  trx: Trx,
  config: ResolvedConfig,
  user: AccountUser,
  context: Parameters<NonNullable<ResolvedConfig['onCredentialsChangedTransaction']>>[1],
  keep?: KeptCredential
): Promise<void> {
  if (config.enabled.includes('socialAuthentication')) await clearSocialPending(trx, user.id)
  // The table is installed for every application, so links die even while the capability is off.
  await trx.from('login_link_tokens').where('tokenable_id', user.id).delete()
  if (config.authentication) await advanceCredentialRevision(trx, config, user.id, keep)
  await config.onCredentialsChangedTransaction?.(user, context, trx)
}
