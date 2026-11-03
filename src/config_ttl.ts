// Validates a configured TTL at boot, naming the configuration field that holds it.
import type { DateTime } from 'luxon'
import { InvalidConfigurationError, InvalidInputError } from './errors.js'
import { expiresAt } from './ttl.js'

export function configuredExpiresAt(field: string, now: DateTime, ttl: string | number): DateTime {
  try {
    return expiresAt(now, ttl)
  } catch (error) {
    if (!(error instanceof InvalidInputError)) throw error
    throw new InvalidConfigurationError(field, error.message, { cause: error })
  }
}
