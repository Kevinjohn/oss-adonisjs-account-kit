// Social helpers shared by the identity, handoff and proof modules: dependencies, clock and actor.
import { DateTime } from 'luxon'
import { requireCurrentAccountInTransaction } from './authentication.js'
import {
  E_ACCOUNT_KIT_SOCIAL_PROOF_INVALID,
  E_ACCOUNT_KIT_SOCIAL_USER_NOT_FOUND,
} from './errors.js'
import { socialProviderNames } from './social_providers.js'
import { sqlTimestamp, type DialectSource } from './timestamps.js'
import type {
  AccountUser,
  SocialCallbackResult,
  SocialIdentity,
  CurrentAccountInput,
  ResolvedConfig,
  SocialProviderName,
  Trx,
  UserId,
} from './types.js'
import type { ServiceDependencies } from './service_dependencies.js'

/** Public outcome and follow-ups belonging to one committed social transaction attempt. */
export interface SocialTransactionResult {
  result: SocialCallbackResult
  unverified?: UserId
  accepted?: { invitationIds: number[]; userId: UserId }
  linkedNotice?: { user: AccountUser; relation: SocialIdentity }
}

export type Dependencies = ServiceDependencies
const MINUTES = 10
export const calculateSocialExpiry = (client: DialectSource) =>
  sqlTimestamp(client, DateTime.utc().plus({ minutes: MINUTES }))
export const readSqlTimestamp = (client: DialectSource) => sqlTimestamp(client)

export function listEnabledSocialProviders(config: ResolvedConfig): SocialProviderName[] {
  return socialProviderNames.filter(
    (name) => config.socialAuthentication?.providers[name] !== undefined
  )
}

export async function requireAuthenticatedUser(
  deps: Dependencies,
  current: CurrentAccountInput | undefined,
  trx: Trx
): Promise<AccountUser> {
  if (!current) throw new E_ACCOUNT_KIT_SOCIAL_PROOF_INVALID()
  await requireCurrentAccountInTransaction(deps, current, trx)
  const user = await deps.config.users.findById(current.userId, trx)
  if (!user) throw new E_ACCOUNT_KIT_SOCIAL_USER_NOT_FOUND()
  return user
}
