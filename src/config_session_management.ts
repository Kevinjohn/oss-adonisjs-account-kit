// Resolves and validates the sign-in idle expiry for session management.
import { DateTime } from 'luxon'
import { InvalidConfigurationError } from './errors.js'
import { sessionTouchIntervalMs } from './session_registry.js'
import { configuredExpiresAt } from './config_ttl.js'
import type { AccountKitConfig, ResolvedConfig } from './types.js'
import { freezeResolved } from './config_freeze.js'

export function resolveSessionManagement(
  config: AccountKitConfig
): ResolvedConfig['sessionManagement'] {
  const value = config.sessionManagement
  if (value !== undefined && (!value || typeof value !== 'object' || Array.isArray(value)))
    throw new InvalidConfigurationError(
      'sessionManagement',
      'account_kit: sessionManagement must be an object'
    )
  const idleExpiry = value?.idleExpiry ?? '30d'
  const now = DateTime.utc()
  if (
    configuredExpiresAt('sessionManagement.idleExpiry', now, idleExpiry).toMillis() -
      now.toMillis() <=
    sessionTouchIntervalMs
  )
    throw new InvalidConfigurationError(
      'sessionManagement.idleExpiry',
      `account_kit: sessionManagement.idleExpiry must be longer than ${sessionTouchIntervalMs / 60_000} minutes`
    )
  return freezeResolved({ idleExpiry })
}
