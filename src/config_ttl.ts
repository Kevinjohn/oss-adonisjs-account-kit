// Validates a configured TTL at boot, naming the configuration field that holds it.
import type { DateTime } from 'luxon'
import { E_ACCOUNT_KIT_INVALID_CONFIGURATION, E_ACCOUNT_KIT_INVALID_INPUT } from './errors.ts'
import { expiresAt } from './ttl.ts'

export function computeConfiguredExpiry(
  field: string,
  now: DateTime,
  ttl: string | number
): DateTime {
  try {
    return expiresAt(now, ttl)
  } catch (error) {
    if (!(error instanceof E_ACCOUNT_KIT_INVALID_INPUT)) throw error
    throw new E_ACCOUNT_KIT_INVALID_CONFIGURATION(
      field,
      `account_kit: ${field}: ${error.message}`,
      { cause: error }
    )
  }
}
