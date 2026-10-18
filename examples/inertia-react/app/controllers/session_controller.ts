import app from '@adonisjs/core/services/app'
import { AccountKit } from 'adonisjs-account-kit'
import { loginValidator } from '#validators/user'
import type { HttpContext } from '@adonisjs/core/http'
import { sessionGuard } from '#services/session_guard'

export default class SessionController {
  async create({ inertia }: HttpContext) {
    return inertia.render('auth/login', {})
  }

  async store(ctx: HttpContext) {
    const { email, password } = await ctx.request.validateUsing(loginValidator)
    const kit = await app.container.make(AccountKit)
    await kit.authentication.login(
      { email, password, clientKey: ctx.request.ip() },
      sessionGuard(ctx)
    )
    ctx.response.redirect().toRoute('dashboard')
  }

  async destroy(ctx: HttpContext) {
    const kit = await app.container.make(AccountKit)
    await kit.authentication.logout(sessionGuard(ctx))
    ctx.response.redirect().toRoute('session.create')
  }
}
