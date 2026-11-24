import type { HttpContext } from '@adonisjs/core/http'
import type { NextFn } from '@adonisjs/core/types/http'
import { errors } from '@kevinjohn/adonisjs-account-kit'
import kit from '@kevinjohn/adonisjs-account-kit/services/main'

export default class VerifiedAccountMiddleware {
  async handle(ctx: HttpContext, next: NextFn) {
    const revision = ctx.session.get('accountKitRevision')

    try {
      await kit.authentication.requireActive({
        userId: ctx.auth.getUserOrFail().id,
        ...(revision === undefined ? {} : { revision: revision === '' ? null : revision }),
      })
    } catch (error) {
      if (!(error instanceof errors.E_ACCOUNT_KIT_UNVERIFIED_EMAIL)) throw error
      ctx.session.flash('error', 'Confirm your email address before opening this page.')
      return ctx.response.redirect().toRoute('dashboard')
    }

    return next()
  }
}
