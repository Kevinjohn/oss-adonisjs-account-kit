import app from '@adonisjs/core/services/app'
import { configProvider } from '@adonisjs/core'
import type { ResolvedConfig } from '@kevinjohn/adonisjs-account-kit/types'
import type { HttpContext } from '@adonisjs/core/http'
import accountKit from '@kevinjohn/adonisjs-account-kit/services/main'
import accountKitConfig from '#config/account_kit'
import { accountInput } from '#middleware/account_access_middleware'
import { lastUsedMethod } from '#services/last_used_method'

export default class AuthMethodsController {
  async methods({ auth, session, response, request }: HttpContext) {
    const current = accountInput({ auth, session })
    const [account, identities] = await Promise.all([
      accountKit.authentication.current(current),
      accountKit.socialAuthentication.list({ current }),
    ])
    const config = await configProvider.resolve<ResolvedConfig>(app, accountKitConfig)
    const configuredProviders = Object.keys(config?.socialAuthentication?.providers ?? {})
    return response.ok({
      password: account.hasPassword,
      configuredProviders,
      lastUsedMethod: lastUsedMethod(
        { request },
        {
          password: account.hasPassword,
          providers: configuredProviders,
        }
      ),
      social: identities.map((identity) => ({ id: identity.id, provider: identity.provider })),
    })
  }
}
