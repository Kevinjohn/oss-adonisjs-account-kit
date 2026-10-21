import kit from 'adonisjs-account-kit/services/main'
import { errors } from 'adonisjs-account-kit'
import type { HttpContext } from '@adonisjs/core/http'
import type { NextFn } from '@adonisjs/core/types/http'

export default class VerifiedAccountMiddleware {
  async handle(ctx: HttpContext, next: NextFn) {
    const user = ctx.auth.getUserOrFail()
    const revision = ctx.session.get('accountKitRevision')
    try {
      await kit.authentication.requireActive({
        userId: user.id,
        ...(revision === undefined ? {} : { revision: revision === '' ? null : revision }),
      })
    } catch (error) {
      if (!(error instanceof errors.UnverifiedEmailError)) throw error
      ctx.session.flash('error', 'Confirm your email address to open this protected page.')
      return ctx.response.redirect().toRoute('dashboard')
    }
    return next()
  }
}
