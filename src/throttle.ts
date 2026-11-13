import { errors } from '@adonisjs/limiter'
import { createHmac, hkdfSync } from 'node:crypto'
import type { LimiterService } from '@adonisjs/limiter/types'
import { ThrottledError } from './errors.js'
import type { ResolvedConfig } from './types.js'

export async function consume(
  limiter: LimiterService,
  operation: string,
  key: string,
  options: ResolvedConfig['throttle'],
  secret: string,
  namespace: string
): Promise<void> {
  const digest = limiterKey(operation, key, secret, namespace)
  try {
    await limiter.use({ ...options }).consume(digest)
  } catch (error) {
    if (error instanceof errors.E_TOO_MANY_REQUESTS) {
      throw new ThrottledError(error.response.availableIn, undefined, { cause: error })
    }
    throw error
  }
}

export function limiterKey(operation: string, key: string, secret: string, namespace: string) {
  // Keep the version-1 salt stable so package renames preserve stored rate-limit budgets.
  const derivedKey = Buffer.from(
    hkdfSync('sha256', secret, 'adonisjs-account-kit', 'limiter-key-v1', 32)
  )
  const digest = createHmac('sha256', derivedKey)
    .update(JSON.stringify([namespace, operation, key]))
    .digest('hex')
  return `account-kit:v1:${digest}`
}

/** Limiter, secret and namespace bound once, so callers pass only what varies per call. */
export interface Throttler {
  consume(operation: string, key: string, budget: ResolvedConfig['throttle']): Promise<void>
  key(operation: string, value: string): string
}

export function makeThrottler(input: {
  limiter: LimiterService
  secret: string
  namespace: string
}): Throttler {
  return {
    consume: (operation, key, budget) =>
      consume(input.limiter, operation, key, budget, input.secret, input.namespace),
    key: (operation, value) => limiterKey(operation, value, input.secret, input.namespace),
  }
}
