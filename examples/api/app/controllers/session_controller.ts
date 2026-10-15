import app from '@adonisjs/core/services/app'
import type { HttpContext } from '@adonisjs/core/http'
import { AccountKit } from 'adonisjs-account-kit'
import User from '#models/user'
import { loginValidator } from '#validators/user'

export default class SessionController {
  csrf({ request }: HttpContext) {
    return { csrfToken: request.csrfToken }
  }

  async store({ auth, request, session, serialize }: HttpContext) {
    const { email, password } = await request.validateUsing(loginValidator)
    const kit = await app.container.make(AccountKit)
    const guard = auth.use('web')
    const result = await kit.authentication.login(
      { email, password, clientKey: request.ip() },
      {
        strategy: 'session',
        name: 'web',
        async establish(userId, revision) {
          session.regenerate()
          await guard.login(await User.findOrFail(userId))
          session.put('accountKitRevision', revision ?? '')
          return undefined
        },
        async terminate() {
          await guard.logout()
          session.clear()
          session.regenerate()
        },
      }
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
