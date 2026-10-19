import type { HttpContext } from '@adonisjs/core/http'
import type { NextFn } from '@adonisjs/core/types/http'
import kit from 'adonisjs-account-kit/services/main'
import { InvalidSessionError } from 'adonisjs-account-kit'

/**
 * Checks on every request whether the user is signed in, and signs out a session that started
 * before the latest password change or reset. Public pages then see no user, and the auth
 * middleware sends protected requests to the login page.
 */
export default class SilentAuthMiddleware {
  async handle(ctx: HttpContext, next: NextFn) {
    if (await ctx.auth.check()) {
      const revision = ctx.session.get('accountKitRevision')
      try {
        await kit.authentication.current({
          userId: ctx.auth.getUserOrFail().id,
          // '' means "signed in before any credential change"; a missing value fails closed.
          ...(revision === undefined ? {} : { revision: revision === '' ? null : revision }),
        })
      } catch (error) {
        if (!(error instanceof InvalidSessionError)) throw error
        await ctx.auth.use('web').logout()
        ctx.session.clear()
        ctx.session.regenerate()
      }
    }

    return next()
  }
}
