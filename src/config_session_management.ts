// Resolves and validates the sign-in idle expiry for session management.
import { DateTime } from 'luxon'
import { E_ACCOUNT_KIT_INVALID_CONFIGURATION } from './errors.ts'
import { sessionTouchIntervalMs } from './session_registry.ts'
import { computeConfiguredExpiry } from './config_ttl.ts'
import type { AccountKitConfig, ResolvedConfig } from './types.ts'
import { freezeResolved } from './config_freeze.ts'

export function resolveSessionManagement(
  config: AccountKitConfig
): ResolvedConfig['sessionManagement'] {
  const value = config.sessionManagement
  if (value !== undefined && (!value || typeof value !== 'object' || Array.isArray(value)))
    throw new E_ACCOUNT_KIT_INVALID_CONFIGURATION(
      'sessionManagement',
      'account_kit: sessionManagement must be an object'
    )
  const idleExpiry = value?.idleExpiry ?? '30d'
  const now = DateTime.utc()
  if (
    computeConfiguredExpiry('sessionManagement.idleExpiry', now, idleExpiry).toMillis() -
      now.toMillis() <=
    sessionTouchIntervalMs
  )
    throw new E_ACCOUNT_KIT_INVALID_CONFIGURATION(
      'sessionManagement.idleExpiry',
      `account_kit: sessionManagement.idleExpiry must be longer than ${sessionTouchIntervalMs / 60_000} minutes`
    )
  return freezeResolved({ idleExpiry })
}
