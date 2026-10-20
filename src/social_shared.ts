// Social helpers shared by the identity, handoff and proof modules: dependencies, clock and actor.
import { DateTime } from 'luxon'
import { currentInTransaction } from './authentication.js'
import { SocialProofError, SocialUserNotFoundError } from './errors.js'
import { socialProviderNames } from './social_providers.js'
import { sqlTimestamp, type DialectSource } from './timestamps.js'
import type {
  AccountUser,
  CurrentAccountInput,
  ResolvedConfig,
  SocialProviderName,
  Trx,
} from './types.js'
import type { ServiceDependencies } from './service_dependencies.js'

export type Dependencies = Omit<ServiceDependencies, 'throttler'>
const MINUTES = 10
export const expiry = (client: DialectSource) =>
  sqlTimestamp(client, DateTime.utc().plus({ minutes: MINUTES }))
export const now = (client: DialectSource) => sqlTimestamp(client)

export function enabledProviders(config: ResolvedConfig): SocialProviderName[] {
  return socialProviderNames.filter(
    (name) => config.socialAuthentication?.providers[name] !== undefined
  )
}

export async function authenticated(
  deps: Dependencies,
  current: CurrentAccountInput | undefined,
  trx: Trx
): Promise<AccountUser> {
  if (!current) throw new SocialProofError()
  await currentInTransaction(deps, current, trx)
  const user = await deps.config.users.findById(current.userId, trx)
  if (!user) throw new SocialUserNotFoundError()
  return user
}
