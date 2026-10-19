// Validates the account deletion settings.
import type { AccountDeletionConfig, AccountKitConfig } from './types.js'

export function resolveAccountDeletion(config: AccountKitConfig): Required<AccountDeletionConfig> {
  const settings = config.accountDeletion ?? {}
  if (!settings || typeof settings !== 'object' || Array.isArray(settings))
    throw new Error('account_kit: accountDeletion must be an object')
  const invitations = settings.invitations ?? 'revoke'
  if (invitations !== 'keep' && invitations !== 'revoke')
    throw new Error('account_kit: accountDeletion.invitations must be keep or revoke')
  return { invitations }
}
