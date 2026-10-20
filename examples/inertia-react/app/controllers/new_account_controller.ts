import kit from 'adonisjs-account-kit/services/main'
import { signupValidator } from '#validators/user'
import type { HttpContext } from '@adonisjs/core/http'
import { sessionGuard } from '#services/session_guard'

export default class NewAccountController {
  async create({ inertia }: HttpContext) {
    return inertia.render('auth/signup', {})
  }

  /**
   * Creates the account and emails a verification link, then signs the new user in. The account
   * stays limited until the link is used.
   */
  async store(ctx: HttpContext) {
    const { fullName, email, password } = await ctx.request.validateUsing(signupValidator)
    await kit.registration.register({ email, password, registrationData: { fullName } })
    await kit.authentication.login(
      { email, password, clientKey: ctx.request.ip() },
      sessionGuard(ctx)
    )
    ctx.session.flash('success', 'Account created. Check your email for a verification link.')
    return ctx.response.redirect().toRoute('dashboard')
  }
}
