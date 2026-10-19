import type { HttpContext } from '@adonisjs/core/http'
import accountKit from 'adonisjs-account-kit/services/main'
import { loginValidator } from '#validators/user'
import { sessionGuard } from '#services/account_kit_guards'
import { rememberLastUsedMethod } from '#services/last_used_method'

export default class SessionController {
  csrf({ request, response }: HttpContext) {
    response.header('Cache-Control', 'no-store')
    return { csrfToken: request.csrfToken }
  }

  async store(ctx: HttpContext) {
    const { request, serialize } = ctx
    const { email, password } = await request.validateUsing(loginValidator)
    const result = await accountKit.authentication.login(
      { email, password, clientKey: request.ip() },
      sessionGuard(ctx)
    )
    rememberLastUsedMethod(ctx, 'password')
    return serialize({ user: result.account })
  }

  async destroy({ auth, session }: HttpContext) {
    await accountKit.authentication.logout({
      async terminate() {
        await auth.use('web').logout()
        session.clear()
        session.regenerate()
      },
    })
    return { message: 'Logged out successfully' }
  }
}
