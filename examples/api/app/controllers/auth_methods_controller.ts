import app from '@adonisjs/core/services/app'
import type { HttpContext } from '@adonisjs/core/http'
import { AccountKit } from 'adonisjs-account-kit'
import accountKitConfig from '#config/account_kit'
import { accountInput } from '#middleware/account_access_middleware'
import { lastUsedMethod } from '#services/last_used_method'

export default class AuthMethodsController {
  async methods(ctx: HttpContext) {
    const current = accountInput(ctx)
    const kit = await app.container.make(AccountKit)
    const [account, identities] = await Promise.all([
      kit.authentication.current(current),
      kit.socialAuthentication.list({ current }),
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
