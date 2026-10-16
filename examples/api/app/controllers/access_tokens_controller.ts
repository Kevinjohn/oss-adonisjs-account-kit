import app from '@adonisjs/core/services/app'
import type { HttpContext } from '@adonisjs/core/http'
import { AccountKit } from 'adonisjs-account-kit'
import User from '#models/user'
import { loginValidator } from '#validators/user'

export default class AccessTokensController {
  async store({ request, serialize }: HttpContext) {
    const { email, password } = await request.validateUsing(loginValidator)

    const kit = await app.container.make(AccountKit)
    const result = await kit.authentication.login(
      { email, password, clientKey: request.ip() },
      {
        strategy: 'access_tokens',
        name: 'api',
        async establish(userId, abilities, expiresIn) {
          const user = await User.findOrFail(userId)
          const token = await User.accessTokens.create(
            user,
            abilities,
            expiresIn === null ? undefined : { expiresIn }
          )
          return { userId, identifier: token.identifier, value: token.value!.release() }
        },
        async terminate(credential) {
          if (!credential) return
          const user = await User.findOrFail(credential.userId)
          await User.accessTokens.delete(user, credential.identifier)
        },
      }
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
