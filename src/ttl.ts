import string from '@adonisjs/core/helpers/string'
import type { DateTime } from 'luxon'
import { InvalidInputError } from './errors.js'

export function expiresAt(now: DateTime, ttl: string): DateTime {
  let seconds: number
  try {
    seconds = string.seconds.parse(ttl)
  } catch (cause) {
    throw new InvalidInputError('TTL must be a positive duration string', { cause })
  }

  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new InvalidInputError('TTL must be a positive duration string')
  }

  const expiration = now.plus({ seconds })
  if (!expiration.isValid) {
    throw new InvalidInputError('TTL must produce a valid expiration date')
  }
  return expiration
}
