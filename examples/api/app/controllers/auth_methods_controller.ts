import type { HttpContext } from '@adonisjs/core/http'
import accountKit from 'adonisjs-account-kit/services/main'
import accountKitConfig from '#config/account_kit'
import { accountInput } from '#middleware/account_access_middleware'
import { lastUsedMethod } from '#services/last_used_method'

export default class AuthMethodsController {
  async methods(ctx: HttpContext) {
    const current = accountInput(ctx)
    const [account, identities] = await Promise.all([
      accountKit.authentication.current(current),
      accountKit.socialAuthentication.list({ current }),
    ])
    const configuredProviders = Object.keys(accountKitConfig.socialAuthentication?.providers ?? {})
    return ctx.response.ok({
      password: account.hasPassword,
      configuredProviders,
      lastUsedMethod: lastUsedMethod(ctx, {
        password: account.hasPassword,
        providers: configuredProviders,
      }),
      social: identities.map((identity) => ({ id: identity.id, provider: identity.provider })),
    })
  }
}
