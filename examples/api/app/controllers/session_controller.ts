import app from '@adonisjs/core/services/app'
import type { HttpContext } from '@adonisjs/core/http'
import { AccountKit } from 'adonisjs-account-kit'
import { loginValidator } from '#validators/user'
import { sessionGuard } from '#services/account_kit_guards'

export default class SessionController {
  csrf({ request, response }: HttpContext) {
    response.header('Cache-Control', 'no-store')
    return { csrfToken: request.csrfToken }
  }

  async store(ctx: HttpContext) {
    const { request, serialize } = ctx
    const { email, password } = await request.validateUsing(loginValidator)
    const kit = await app.container.make(AccountKit)
    const result = await kit.authentication.login(
      { email, password, clientKey: request.ip() },
      sessionGuard(ctx)
    )
    return serialize({ user: result.account })
  }

  async destroy({ auth, session }: HttpContext) {
    const kit = await app.container.make(AccountKit)
    await kit.authentication.logout({
      async terminate() {
        await auth.use('web').logout()
        session.clear()
        session.regenerate()
      },
    })
    return { message: 'Logged out successfully' }
  }
}
