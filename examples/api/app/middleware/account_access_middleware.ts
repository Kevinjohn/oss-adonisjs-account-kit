import app from '@adonisjs/core/services/app'
import type { HttpContext } from '@adonisjs/core/http'
import type { NextFn } from '@adonisjs/core/types/http'
import { AccountKit } from 'adonisjs-account-kit'
import env from '#start/env'

/** Apply to application-owned routes as well as package-backed routes. */
export default class AccountAccessMiddleware {
  async handle(ctx: HttpContext, next: NextFn, options: { allowInactive?: boolean } = {}) {
    const strategy = env.get('ACCOUNT_KIT_AUTH_STRATEGY') ?? 'access_tokens'
    const user = ctx.auth.use(strategy === 'session' ? 'web' : 'api').getUserOrFail()
    const revision = ctx.session.get('accountKitRevision')
    const input =
      strategy === 'session'
        ? {
            userId: user.id,
            ...(revision === undefined ? {} : { revision: revision === '' ? null : revision }),
          }
        : { userId: user.id, tokenId: user.currentAccessToken?.identifier?.toString() }
    const kit = await app.container.make(AccountKit)
    if (options.allowInactive) await kit.authentication.current(input)
    else await kit.authentication.requireActive(input)
    return next()
  }
}
