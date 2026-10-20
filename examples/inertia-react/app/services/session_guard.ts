import User from '#models/user'
import type { HttpContext } from '@adonisjs/core/http'

/**
 * Lets Account Kit sign users in and out through the existing `web` session guard. The stored
 * revision is checked on every request by the session revision middleware.
 */
export function sessionGuard(ctx: HttpContext) {
  const guard = ctx.auth.use('web')
  return {
    strategy: 'session' as const,
    name: 'web',
    async establish(userId: number | string, revision: string | null) {
      ctx.session.regenerate()
      await guard.login(await User.findOrFail(userId))
      ctx.session.put('accountKitRevision', revision ?? '')
      return undefined
    },
    async terminate() {
      await guard.logout()
      ctx.session.clear()
      ctx.session.regenerate()
    },
  }
}
