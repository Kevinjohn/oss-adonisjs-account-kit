import type { HttpContext } from '@adonisjs/core/http'
import type { SocialCallbackResult } from '@kevinjohn/adonisjs-account-kit'
import accountKit from '@kevinjohn/adonisjs-account-kit/services/main'
import User from '#models/user'
import UserTransformer from '#transformers/user_transformer'
import { accountKitSessionGuard } from '#services/account_kit_guards'
import { rememberLastUsedMethod } from '#services/last_used_method'

/** Finish a callback or continuation with its original browser transaction. */
export async function finishSocialCallback(
  ctx: HttpContext,
  result: SocialCallbackResult,
  browserVerifier?: string
) {
  if ('handoffCode' in result && result.handoffCode && browserVerifier) {
    const redeemed = await accountKit.socialAuthentication.redeemHandoff({
      code: result.handoffCode,
      verifier: browserVerifier,
      guard: accountKitSessionGuard(ctx),
    })
    const user = await User.findOrFail(redeemed.account.id)
    rememberLastUsedMethod(ctx, redeemed.provider)
    return ctx.serialize({ status: result.status, user: UserTransformer.transform(user) })
  }
  return ctx.response.ok(result)
}
