import type { HttpContext } from '@adonisjs/core/http'
import accountKit from 'adonisjs-account-kit/services/main'
import User from '#models/user'
import { loginValidator } from '#validators/user'
import { accessTokenGuard } from '#services/account_kit_guards'
import { rememberLastUsedMethod } from '#services/last_used_method'

export default class AccessTokensController {
  async store(ctx: HttpContext) {
    const { request, serialize } = ctx
    const { email, password } = await request.validateUsing(loginValidator)

    const result = await accountKit.authentication.login(
      { email, password, clientKey: request.ip() },
      accessTokenGuard()
    )
    rememberLastUsedMethod(ctx, 'password')
    return serialize({ user: result.account, token: result.credential.value })
  }

  async destroy({ auth }: HttpContext) {
    const user = auth.use('api').getUserOrFail()
    await accountKit.authentication.logout({
      async terminate() {
        if (user.currentAccessToken) {
          await User.accessTokens.delete(user, user.currentAccessToken.identifier)
        }
      },
    })
    return { message: 'Logged out successfully' }
  }
}
