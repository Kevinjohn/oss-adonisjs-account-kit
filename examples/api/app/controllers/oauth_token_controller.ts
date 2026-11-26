import type { HttpContext } from '@adonisjs/core/http'
import { E_ACCOUNT_KIT_INVALID_INPUT } from '@kevinjohn/adonisjs-account-kit'
import accountKit from '@kevinjohn/adonisjs-account-kit/services/main'
import User from '#models/user'
import UserTransformer from '#transformers/user_transformer'
import { accessTokenGuard } from '#services/account_kit_guards'
import { rememberLastUsedMethod } from '#services/last_used_method'
import { authStrategy } from '#services/auth_strategy'
import { tokenRedeemValidator } from '#validators/social'

export default class OauthTokenController {
  async redeem({ response, request, serialize }: HttpContext) {
    response.header('Cache-Control', 'no-store')
    if (authStrategy() !== 'access_tokens')
      throw new E_ACCOUNT_KIT_INVALID_INPUT('Token exchange is unavailable')
    const { code, verifier } = await request.validateUsing(tokenRedeemValidator)
    const result = await accountKit.socialAuthentication.redeemHandoff({
      code,
      verifier,
      guard: accessTokenGuard(),
    })
    const user = await User.findOrFail(result.account.id)
    rememberLastUsedMethod({ response }, result.provider)
    return serialize({ user: UserTransformer.transform(user), token: result.credential.value })
  }
}
