import string from '@adonisjs/core/helpers/string'
import type { DateTime } from 'luxon'
import { E_ACCOUNT_KIT_INVALID_INPUT } from './errors.ts'

export function expiresAt(now: DateTime, ttl: string | number): DateTime {
  let seconds: number
  if (typeof ttl === 'number') {
    seconds = ttl
  } else {
    try {
      seconds = string.seconds.parse(ttl)
    } catch (cause) {
      throw new E_ACCOUNT_KIT_INVALID_INPUT('TTL must be a positive duration string or seconds', {
        cause,
      })
    }
  }

  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new E_ACCOUNT_KIT_INVALID_INPUT('TTL must be a positive duration string or seconds')
  }

  const expiration = now.plus({ seconds })
  if (!expiration.isValid) {
    throw new E_ACCOUNT_KIT_INVALID_INPUT('TTL must produce a valid expiration date')
  }
  return expiration
}
