import type { HttpContext } from '@adonisjs/core/http'
import type { NextFn } from '@adonisjs/core/types/http'
import type { Authenticators } from '@adonisjs/auth/types'
import env from '#start/env'

/**
 * Auth middleware is used authenticate HTTP requests and deny
 * access to unauthenticated users.
 */
export default class AuthMiddleware {
  async handle(
    ctx: HttpContext,
    next: NextFn,
    options: {
      guards?: (keyof Authenticators)[]
    } = {}
  ) {
    const selectedGuard = env.get('ACCOUNT_KIT_AUTH_STRATEGY') === 'session' ? 'web' : 'api'
    await ctx.auth.authenticateUsing(options.guards ?? [selectedGuard])
    return next()
  }
}
