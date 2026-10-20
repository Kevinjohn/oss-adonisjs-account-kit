import kit from 'adonisjs-account-kit/services/main'
import { loginValidator } from '#validators/user'
import type { HttpContext } from '@adonisjs/core/http'
import { accountKitSessionGuard } from '#services/session_guard'

export default class SessionController {
  async create({ inertia }: HttpContext) {
    return inertia.render('auth/login', {})
  }

  async store(ctx: HttpContext) {
    const { email, password } = await ctx.request.validateUsing(loginValidator)
    await kit.authentication.login(
      { email, password, clientKey: ctx.request.ip() },
      accountKitSessionGuard(ctx)
    )
    return ctx.response.redirect().toRoute('dashboard')
  }

  async destroy(ctx: HttpContext) {
    await kit.authentication.logout(accountKitSessionGuard(ctx))
    return ctx.response.redirect().toRoute('session.create')
  }
}
