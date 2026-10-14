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
  namespace = 'default'
): Promise<void> {
  const derivedKey = Buffer.from(
    hkdfSync('sha256', secret, 'adonisjs-account-kit', 'limiter-key-v1', 32)
  )
  const digest = createHmac('sha256', derivedKey)
    .update(JSON.stringify([namespace, operation, key]))
    .digest('hex')
  try {
    await limiter.use({ ...options }).consume(`account-kit:v1:${digest}`)
  } catch (error) {
    if (error instanceof errors.E_TOO_MANY_REQUESTS) {
      throw new ThrottledError(error.response.availableIn, undefined, { cause: error })
    }
    throw error
  }
}
