import app from '@adonisjs/core/services/app'
import type { HttpContext } from '@adonisjs/core/http'
import { AccountKit } from 'adonisjs-account-kit'
import User from '#models/user'
import { loginValidator } from '#validators/user'
import { accessTokenGuard } from '#services/account_kit_guards'

export default class AccessTokensController {
  async store({ request, serialize }: HttpContext) {
    const { email, password } = await request.validateUsing(loginValidator)

    const kit = await app.container.make(AccountKit)
    const result = await kit.authentication.login(
      { email, password, clientKey: request.ip() },
      accessTokenGuard()
    )
    return serialize({ user: result.account, token: result.credential.value })
  }

  async destroy({ auth }: HttpContext) {
    const user = auth.use('api').getUserOrFail()
    const kit = await app.container.make(AccountKit)
    await kit.authentication.logout({
      async terminate() {
        if (user.currentAccessToken) {
          await User.accessTokens.delete(user, user.currentAccessToken.identifier)
        }
      },
    })
    return { message: 'Logged out successfully' }
  }
}
