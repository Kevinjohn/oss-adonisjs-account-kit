import app from '@adonisjs/core/services/app'
import { AccountKit } from 'adonisjs-account-kit'
import env from '#start/env'
import type { HttpContext } from '@adonisjs/core/http'

export default class ProfileController {
  async show({ auth, session, serialize }: HttpContext) {
    const strategy = env.get('ACCOUNT_KIT_AUTH_STRATEGY') ?? 'access_tokens'
    const user = auth.use(strategy === 'session' ? 'web' : 'api').getUserOrFail()
    const revision = session.get('accountKitRevision')
    const input =
      strategy === 'session'
        ? {
            userId: user.id,
            ...(revision === undefined ? {} : { revision: revision === '' ? null : revision }),
          }
        : { userId: user.id, tokenId: user.currentAccessToken?.identifier?.toString() }
    const kit = await app.container.make(AccountKit)
    return serialize(await kit.authentication.current(input))
  }
}
