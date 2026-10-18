// The package-owned rows that belong to one user, and deleting them before the user row.
import type { ResolvedConfig, Trx, UserId } from './types.js'

/**
 * Package tables with a row per user, in deletion order: handoff codes reference identities.
 * Social tables are always listed because their migrations are always installed, and disabling
 * social sign-in does not remove existing rows.
 */
export const userOwnedRows = [
  { table: 'social_handoff_codes', column: 'user_id' },
  { table: 'social_sensitive_proofs', column: 'user_id' },
  { table: 'social_transactions', column: 'user_id' },
  { table: 'social_identities', column: 'user_id' },
  { table: 'password_reset_tokens', column: 'tokenable_id' },
  { table: 'email_verification_tokens', column: 'tokenable_id' },
] as const

/**
 * Delete every package row of the user explicitly rather than relying on foreign-key cascades,
 * which a custom schema may lack. Access tokens are deleted only for the token strategy; the
 * user's sent invitations follow `accountDeletion.invitations`.
 */
export async function deleteUserRows(trx: Trx, config: ResolvedConfig, userId: UserId) {
  for (const { table, column } of userOwnedRows)
    await trx.from(table).where(column, userId).delete()
  if (config.authentication?.strategy === 'access_tokens')
    await trx.from(config.authentication.tokenTable).where('tokenable_id', userId).delete()
  const sent = trx.from('account_invitations').where('inviter_id', userId)
  if (config.accountDeletion.invitations === 'keep') await sent.update({ inviter_id: null })
  else await sent.delete()
}
