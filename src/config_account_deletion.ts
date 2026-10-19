// Validates the account export and deletion settings and hooks.
import type { AccountDeletionConfig, AccountKitConfig } from './types.js'

export function resolveAccountDeletion(config: AccountKitConfig): Required<AccountDeletionConfig> {
  for (const hook of ['exportAccountData', 'onAccountDeletingTransaction'] as const) {
    if (config[hook] !== undefined && typeof config[hook] !== 'function')
      throw new Error(`account_kit: ${hook} must be a function when supplied`)
  }
  const settings = config.accountDeletion ?? {}
  if (!settings || typeof settings !== 'object' || Array.isArray(settings))
    throw new Error('account_kit: accountDeletion must be an object')
  const invitations = settings.invitations ?? 'revoke'
  if (invitations !== 'keep' && invitations !== 'revoke')
    throw new Error('account_kit: accountDeletion.invitations must be keep or revoke')
  return { invitations }
}
