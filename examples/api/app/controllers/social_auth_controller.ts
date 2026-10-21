import type { HttpContext } from '@adonisjs/core/http'
import {
  InvalidInputError,
  type SocialCallbackResult,
  type SocialProviderName,
} from 'adonisjs-account-kit'
import accountKit from 'adonisjs-account-kit/services/main'
import User from '#models/user'
import UserTransformer from '#transformers/user_transformer'
import { accountKitSessionGuard } from '#services/account_kit_guards'
import { rememberLastUsedMethod } from '#services/last_used_method'
import {
  beginBrowserTransaction,
  forgetBrowserContinuation,
  forgetBrowserTransaction,
  pendingBrowserContinuation,
  pendingBrowserTransaction,
  rememberBrowserContinuation,
} from '#services/social_browser_transaction'
import { currentIfAuthenticated } from '#services/social_request'
import {
  socialCallbackValidator,
  socialConfirmValidator,
  socialRedirectValidator,
} from '#validators/social'
import { socialRegistrationValidator } from '#validators/user'

function providerParam(value: string): SocialProviderName {
  if (value !== 'google' && value !== 'github') throw new InvalidInputError('Unknown provider')
  return value
}

export default class SocialAuthController {
  async redirect(ctx: HttpContext) {
    const provider = providerParam(ctx.params.provider)
    const input = await ctx.request.validateUsing(socialRedirectValidator)
    const intent = input.intent ?? 'login'
    const current = intent === 'login' ? undefined : await currentIfAuthenticated(ctx)
    const transaction = beginBrowserTransaction(ctx, input.clientChallenge)
    const result = await accountKit.socialAuthentication.begin({
      provider,
      intent,
      current,
      clientChallenge: transaction.clientChallenge,
      purpose: input.purpose,
      proof: input.proof,
      context: ctx,
    })
    transaction.remember(result.state)
    return ctx.response.ok({ authorizationUrl: result.url })
  }

  async confirm(ctx: HttpContext) {
    const provider = providerParam(ctx.params.provider)
    const { verificationToken, clientChallenge } =
      await ctx.request.validateUsing(socialConfirmValidator)
    const transaction = beginBrowserTransaction(ctx, clientChallenge)
    const result = await accountKit.socialAuthentication.beginConfirmation({
      provider,
      verificationToken,
      clientChallenge: transaction.clientChallenge,
      context: ctx,
    })
    transaction.remember(result.state)
    return ctx.response.ok({ authorizationUrl: result.url })
  }

  async verificationEntry(ctx: HttpContext) {
    ctx.response.header('Cache-Control', 'no-store')
    ctx.response.header('Referrer-Policy', 'no-referrer')
    return ctx.response.ok({ verificationToken: ctx.params.token })
  }

  async callback(ctx: HttpContext) {
    ctx.response.header('Cache-Control', 'no-store')
    ctx.response.header('Referrer-Policy', 'no-referrer')
    const provider = providerParam(ctx.params.provider)
    const { state, intent } = await ctx.request.validateUsing(socialCallbackValidator)
    const pending = pendingBrowserTransaction(ctx, state)
    const current = await currentIfAuthenticated(ctx)
    const result = await accountKit.socialAuthentication.callback({
      state,
      provider,
      callback: ctx,
      current,
      intent,
    })
    if (pending) forgetBrowserTransaction(ctx)
    if ('continuation' in result) {
      if (pending) rememberBrowserContinuation(ctx, result.continuation, pending)
      return ctx.response.ok({ status: 'new', continuation: result.continuation })
    }
    return this.finishCallback(ctx, result, pending?.verifier)
  }

  private async finishCallback(
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

  async completeRegistration(ctx: HttpContext) {
    ctx.response.header('Cache-Control', 'no-store')
    const { continuation, fullName, email } = await ctx.request.validateUsing(
      socialRegistrationValidator
    )
    const pending = pendingBrowserContinuation(ctx, continuation)
    const result = await accountKit.socialAuthentication.completeRegistration({
      continuation,
      email,
      registrationData: { fullName },
    })
    if (pending) {
      forgetBrowserContinuation(ctx)
      return this.finishCallback(ctx, result, pending.verifier)
    }
    return ctx.response.ok(result)
  }
}
