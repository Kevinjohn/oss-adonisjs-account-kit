import type { HttpContext } from '@adonisjs/core/http'
import { authStrategy, selectedGuardName } from '#services/auth_strategy'

export function accountInput(ctx: HttpContext) {
  const user = ctx.auth.use(selectedGuardName()).getUserOrFail()
  const revision = ctx.session.get('accountKitRevision')
  return authStrategy() === 'session'
    ? {
        userId: user.id,
        ...(revision === undefined ? {} : { revision: revision === '' ? null : revision }),
      }
    : { userId: user.id, tokenId: user.currentAccessToken?.identifier?.toString() }
}
