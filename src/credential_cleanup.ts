// Deletes the recovery tokens and pending social state a credential change must invalidate.
import type { Trx, UserId } from './types.js'

type RecoveryTokenTable = 'password_reset_tokens' | 'email_verification_tokens'

/** Delete the user's outstanding recovery tokens, one table at a time in the order given. */
export async function clearRecoveryTokens(
  trx: Trx,
  userId: UserId,
  tables: RecoveryTokenTable[]
): Promise<void> {
  for (const table of tables) await trx.from(table).where('tokenable_id', userId).delete()
}

/** Delete the user's in-flight social callbacks. */
export async function clearSocialTransactions(trx: Trx, userId: UserId): Promise<void> {
  await trx.from('social_transactions').where('user_id', userId).delete()
}

/** Delete the user's sensitive-action proofs, then their in-flight social callbacks. */
export async function clearSocialPending(trx: Trx, userId: UserId): Promise<void> {
  await trx.from('social_sensitive_proofs').where('user_id', userId).delete()
  await clearSocialTransactions(trx, userId)
}

/** Delete the user's unconfirmed social identities, keeping `exceptId` when given. */
export async function clearPendingSocialIdentities(
  trx: Trx,
  userId: UserId,
  exceptId?: number
): Promise<void> {
  const pending = trx.from('social_identities').where('user_id', userId).whereNull('confirmed_at')
  if (exceptId !== undefined) pending.whereNot('id', exceptId)
  await pending.delete()
}
