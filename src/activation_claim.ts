import { sqlTimestamp } from './timestamps.js'
import {
  clearPendingSocialIdentities,
  clearRecoveryTokens,
  clearSocialTransactions,
} from './credential_cleanup.js'
import { DateTime } from 'luxon'
import { consumeUserTokenHash } from './db.js'
import { matchInvitation } from './invitation_match.js'
import type { AccountUser, ResolvedConfig, UserId, Trx } from './types.js'

export type ActivationRow = {
  tokenable_id: UserId
  email: string
  current_email: string
  purpose: string
}

/** An activation proof still matches when the user is unverified at the address it was sent to. */
export function activationMatches(
  proof: Pick<ActivationRow, 'purpose' | 'email' | 'current_email'>,
  user: Pick<AccountUser, 'email' | 'unverifiedEmail'>
): boolean {
  return (
    proof.purpose === 'activation' &&
    user.unverifiedEmail === user.email &&
    user.unverifiedEmail === proof.email &&
    user.email === proof.current_email
  )
}

/**
 * Shared activation effects; caller must hold the account lock and have consumed email proof.
 * Returns the id of the invitation the confirmed address consumed, if any.
 */
export async function activateClaim(
  trx: Trx,
  config: ResolvedConfig,
  user: AccountUser,
  confirmedSocialIdentityId?: number
): Promise<number | null> {
  const userId = user.id
  const now = DateTime.utc()
  await config.users.markEmailVerified(userId, now, trx)
  const invitationId = await matchInvitation(config, trx, user, now)
  await clearRecoveryTokens(trx, userId, ['password_reset_tokens'])
  if (config.enabled.includes('socialAuthentication')) {
    await clearPendingSocialIdentities(trx, userId, confirmedSocialIdentityId)
    if (confirmedSocialIdentityId !== undefined)
      await trx
        .from('social_identities')
        .where('user_id', userId)
        .where('id', confirmedSocialIdentityId)
        .whereNull('confirmed_at')
        .update({ confirmed_at: sqlTimestamp(trx) })
    await clearSocialTransactions(trx, userId)
  }
  return invitationId
}

/** Consume email ownership proof under the user lock. Only a matched provider can be confirmed. */
export async function completeActivationByHash(
  trx: Trx,
  config: ResolvedConfig,
  tokenHash: string,
  confirmedSocialIdentityId?: number
): Promise<{ userId: UserId; invitationId: number | null }> {
  const { user } = await consumeUserTokenHash<ActivationRow>(
    trx,
    config,
    'email_verification_tokens',
    tokenHash,
    activationMatches
  )
  const invitationId = await activateClaim(trx, config, user, confirmedSocialIdentityId)
  return { userId: user.id, invitationId }
}
