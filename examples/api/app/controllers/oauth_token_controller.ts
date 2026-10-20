import type { HttpContext } from '@adonisjs/core/http'
import { InvalidInputError } from 'adonisjs-account-kit'
import accountKit from 'adonisjs-account-kit/services/main'
import { accessTokenGuard } from '#services/account_kit_guards'
import { rememberLastUsedMethod } from '#services/last_used_method'
import { authStrategy } from '#services/auth_strategy'
import { tokenRedeemValidator } from '#validators/social'

export default class OauthTokenController {
  async redeem(ctx: HttpContext) {
    ctx.response.header('Cache-Control', 'no-store')
    if (authStrategy() !== 'access_tokens')
      throw new InvalidInputError('Token exchange is unavailable')
    const { code, verifier } = await ctx.request.validateUsing(tokenRedeemValidator)
    const result = await accountKit.socialAuthentication.redeemHandoff({
      code,
      verifier,
      guard: accessTokenGuard(),
    })
    rememberLastUsedMethod(ctx, result.provider)
    return ctx.response.ok({ account: result.account, token: result.credential.value })
  }
}
