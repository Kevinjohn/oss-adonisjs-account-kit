import { createHmac } from 'node:crypto'
import { errors } from '@adonisjs/limiter'
import limiter from '@adonisjs/limiter/services/main'
import type { HttpContext } from '@adonisjs/core/http'
import type { NextFn } from '@adonisjs/core/types/http'
import { ThrottledError } from 'adonisjs-account-kit'
import env from '#start/env'
import { accountInput } from '#middleware/account_access_middleware'

type Operation = 'begin' | 'confirm' | 'callback' | 'registration' | 'redeem' | 'proof' | 'unlink'

const budgets: Record<Operation, number> = {
  begin: 20,
  confirm: 10,
  callback: 30,
  registration: 10,
  redeem: 20,
  proof: 5,
  unlink: 10,
}

/** Uses the configured shared limiter store; no raw IP or account ID becomes a store key. */
export default class SocialThrottleMiddleware {
  async handle(ctx: HttpContext, next: NextFn, options: { operation: Operation; actor?: boolean }) {
    const value = options.actor ? String(accountInput(ctx).userId) : ctx.request.ip()
    const key = createHmac('sha256', env.get('APP_KEY').release())
      .update(JSON.stringify(['social-reference', options.operation, value]))
      .digest('hex')
    try {
      await limiter.use({ requests: budgets[options.operation], duration: '15m' }).consume(key)
    } catch (error) {
      if (error instanceof errors.E_TOO_MANY_REQUESTS) {
        throw new ThrottledError(error.response.availableIn, undefined, { cause: error })
      }
      throw error
    }
    return next()
  }
}
