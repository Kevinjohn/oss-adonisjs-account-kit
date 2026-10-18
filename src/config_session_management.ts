// Resolves and validates the sign-in idle expiry for session management.
import { DateTime } from 'luxon'
import { expiresAt } from './ttl.js'
import type { AccountKitConfig, ResolvedConfig } from './types.js'

/** Seen sign-ins are refreshed at most this often, so idle expiry must be longer. */
export const sessionTouchIntervalMs = 5 * 60 * 1000

export function resolveSessionManagement(
  config: AccountKitConfig
): ResolvedConfig['sessionManagement'] {
  const value = config.sessionManagement
  if (value !== undefined && (!value || typeof value !== 'object' || Array.isArray(value)))
    throw new Error('account_kit: sessionManagement must be an object')
  const idleExpiry = value?.idleExpiry ?? '30d'
  const now = DateTime.utc()
  if (expiresAt(now, idleExpiry).toMillis() - now.toMillis() <= sessionTouchIntervalMs)
    throw new Error('account_kit: sessionManagement.idleExpiry must be longer than five minutes')
  return { idleExpiry }
}
