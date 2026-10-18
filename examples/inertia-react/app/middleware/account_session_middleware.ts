import app from '@adonisjs/core/services/app'
import { AccountKit } from 'adonisjs-account-kit'
import type { HttpContext } from '@adonisjs/core/http'
import type { NextFn } from '@adonisjs/core/types/http'

/**
 * Rejects sessions that started before the latest password change or reset. Runs after the
 * auth middleware.
 */
export default class AccountSessionMiddleware {
  async handle(ctx: HttpContext, next: NextFn) {
    const kit = await app.container.make(AccountKit)
    const revision = ctx.session.get('accountKitRevision')
    await kit.authentication.current({
      userId: ctx.auth.getUserOrFail().id,
      // '' means "signed in before any credential change"; a missing value fails closed.
      ...(revision === undefined ? {} : { revision: revision === '' ? null : revision }),
    })
    return next()
  }
}
