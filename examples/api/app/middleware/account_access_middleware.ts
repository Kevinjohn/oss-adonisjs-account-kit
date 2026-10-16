import app from '@adonisjs/core/services/app'
import type { HttpContext } from '@adonisjs/core/http'
import type { NextFn } from '@adonisjs/core/types/http'
import { AccountKit } from 'adonisjs-account-kit'
import env from '#start/env'

export function accountInput(ctx: HttpContext) {
  const strategy = env.get('ACCOUNT_KIT_AUTH_STRATEGY') ?? 'access_tokens'
  const user = ctx.auth.use(strategy === 'session' ? 'web' : 'api').getUserOrFail()
  const revision = ctx.session.get('accountKitRevision')
  return strategy === 'session'
    ? {
        userId: user.id,
        ...(revision === undefined ? {} : { revision: revision === '' ? null : revision }),
      }
    : { userId: user.id, tokenId: user.currentAccessToken?.identifier?.toString() }
}

/** Credential and restriction gate for routes an inactive account may use. */
export default class AccountAccessMiddleware {
  async handle(ctx: HttpContext, next: NextFn) {
    const kit = await app.container.make(AccountKit)
    await kit.authentication.current(accountInput(ctx))
    return next()
  }
}
