import type { HttpContext } from '@adonisjs/core/http'
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
