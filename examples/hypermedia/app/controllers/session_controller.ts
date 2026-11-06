import kit from '@kevinjohn/adonisjs-account-kit/services/main'
import { errors } from '@kevinjohn/adonisjs-account-kit'
import type { HttpContext } from '@adonisjs/core/http'
import { loginValidator } from '#validators/user'
import { accountKitSessionGuard } from '#services/session_guard'

export default class SessionController {
  async create({ view }: HttpContext) {
    return view.render('pages/auth/login')
  }

  async store(ctx: HttpContext) {
    const { email, password } = await ctx.request.validateUsing(loginValidator)
    let active: boolean
    try {
      const { account } = await kit.authentication.login(
        { email, password, clientKey: ctx.request.ip() },
        accountKitSessionGuard(ctx)
      )
      active = account.active
    } catch (error) {
      // ThrottledError reaches the exception handler, which asks the person to wait.
      if (!(error instanceof errors.InvalidCredentialsError)) throw error
      ctx.session.flash(
        'error',
        'The email or password is incorrect. Check your details and try again.'
      )
      ctx.session.flashOnly(['email'])
      return ctx.response.redirect().back()
    }
    ctx.session.flash(
      'success',
      active
        ? 'You are signed in.'
        : 'You are signed in. Confirm your email to access protected account pages.'
    )
    return ctx.response.redirect().toRoute('dashboard')
  }

  async destroy(ctx: HttpContext) {
    await kit.authentication.logout(accountKitSessionGuard(ctx))
    return ctx.response.redirect().toRoute('session.create')
  }
}
