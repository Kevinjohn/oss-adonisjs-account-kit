import { errors, type LimiterManager } from '@adonisjs/limiter'
import type { LimiterManagerStoreFactory } from '@adonisjs/limiter/types'
import { ThrottledError } from './errors.js'
import type { ResolvedConfig } from './types.js'

export async function consume(
  limiter: LimiterManager<Record<string, LimiterManagerStoreFactory>>,
  operation: string,
  key: string,
  options: ResolvedConfig['throttle']
): Promise<void> {
  try {
    await limiter.use({ ...options }).consume(`account-kit:${operation}:${key}`)
  } catch (error) {
    if (error instanceof errors.E_TOO_MANY_REQUESTS) {
      throw new ThrottledError(error.response.availableIn, 'Too many requests', { cause: error })
    }
    throw error
  }
}
