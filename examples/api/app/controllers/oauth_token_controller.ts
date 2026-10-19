import type { HttpContext } from '@adonisjs/core/http'
import { InvalidInputError } from 'adonisjs-account-kit'
import accountKit from 'adonisjs-account-kit/services/main'
import User from '#models/user'
import UserTransformer from '#transformers/user_transformer'
import { accessTokenGuard } from '#services/account_kit_guards'
import { rememberLastUsedMethod } from '#services/last_used_method'
import { requiredString, socialStrategy } from '#services/social_request'

export default class OauthTokenController {
  async redeem(ctx: HttpContext) {
    ctx.response.header('Cache-Control', 'no-store')
    if (socialStrategy() !== 'access_tokens')
      throw new InvalidInputError('Token exchange is unavailable')
    const code = requiredString(ctx.request.input('code'), 'code')
    const verifier = requiredString(ctx.request.input('verifier'), 'verifier')
    const result = await accountKit.socialAuthentication.redeemHandoff({
      code,
      verifier,
      guard: accessTokenGuard(),
    })
    const user = await User.findOrFail(result.account.id)
    rememberLastUsedMethod(ctx, result.provider)
    return ctx.serialize({ user: UserTransformer.transform(user), token: result.credential.value })
  }
}
