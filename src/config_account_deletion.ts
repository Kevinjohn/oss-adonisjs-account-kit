// Validates the account deletion settings.
import { E_ACCOUNT_KIT_INVALID_CONFIGURATION } from './errors.js'
import type { AccountDeletionConfig, AccountKitConfig } from './types.js'
import { freezeResolved } from './config_freeze.js'

export function resolveAccountDeletion(config: AccountKitConfig): Required<AccountDeletionConfig> {
  const settings = config.accountDeletion ?? {}
  if (!settings || typeof settings !== 'object' || Array.isArray(settings))
    throw new E_ACCOUNT_KIT_INVALID_CONFIGURATION(
      'accountDeletion',
      'account_kit: accountDeletion must be an object'
    )
  const invitations = settings.invitations ?? 'revoke'
  if (invitations !== 'keep' && invitations !== 'revoke')
    throw new E_ACCOUNT_KIT_INVALID_CONFIGURATION(
      'accountDeletion.invitations',
      'account_kit: accountDeletion.invitations must be keep or revoke'
    )
  return freezeResolved({ invitations })
}
