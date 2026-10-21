import kit from 'adonisjs-account-kit/services/main'
import { errors } from 'adonisjs-account-kit'
import type { HttpContext } from '@adonisjs/core/http'
import { loginValidator } from '#validators/user'
import { accountKitSessionGuard } from '#services/session_guard'

export default class SessionController {
  async create({ view }: HttpContext) {
    return view.render('pages/auth/login')
  }

  async store(ctx: HttpContext) {
    const { email, password } = await ctx.request.validateUsing(loginValidator)
    try {
      await kit.authentication.login(
        { email, password, clientKey: ctx.request.ip() },
        accountKitSessionGuard(ctx)
      )
    } catch (error) {
      if (
        !(error instanceof errors.InvalidCredentialsError) &&
        !(error instanceof errors.ThrottledError)
      )
        throw error
      ctx.session.flash(
        'error',
        'The email or password is incorrect. Check your details and try again.'
      )
      ctx.session.flash('old', { email })
      return ctx.response.redirect().back()
    }
    ctx.session.flash(
      'success',
      'You are signed in. Confirm your email to access protected account pages.'
    )
    return ctx.response.redirect().toRoute('dashboard')
  }

  async destroy(ctx: HttpContext) {
    await kit.authentication.logout(accountKitSessionGuard(ctx))
    return ctx.response.redirect().toRoute('session.create')
  }
}
