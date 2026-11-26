import type { HttpContext } from '@adonisjs/core/http'
import {
  E_ACCOUNT_KIT_INVALID_INPUT,
  type SocialCallbackResult,
  type SocialProviderName,
} from '@kevinjohn/adonisjs-account-kit'
import accountKit from '@kevinjohn/adonisjs-account-kit/services/main'
import UserTransformer from '#transformers/user_transformer'
import { accountKitSessionGuard } from '#services/account_kit_guards'
import { rememberLastUsedMethod } from '#services/last_used_method'
import { redeemSocialHandoff } from '#services/social_handoff_redemption'
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
  if (value !== 'google' && value !== 'github')
    throw new E_ACCOUNT_KIT_INVALID_INPUT('Unknown provider')
  return value
}

/** Finish a callback or continuation with its original browser transaction. */
async function finishSocialCallback(
  {
    auth,
    session,
    response,
    serialize,
  }: Pick<HttpContext, 'auth' | 'session' | 'response' | 'serialize'>,
  result: SocialCallbackResult,
  browserVerifier?: string
) {
  if ('handoffCode' in result && result.handoffCode && browserVerifier) {
    const { user, provider } = await redeemSocialHandoff({
      code: result.handoffCode,
      verifier: browserVerifier,
      guard: accountKitSessionGuard({ auth, session }),
    })
    rememberLastUsedMethod({ response }, provider)
    return serialize({ status: result.status, user: UserTransformer.transform(user) })
  }
  return response.ok(result)
}

export default class SocialAuthController {
  async redirect({ params, request, auth, session, ally, response }: HttpContext) {
    const provider = providerParam(params.provider)
    const input = await request.validateUsing(socialRedirectValidator)
    const intent = input.intent ?? 'login'
    const current = intent === 'login' ? undefined : await currentIfAuthenticated({ auth, session })
    const transaction = beginBrowserTransaction({ session }, input.clientChallenge)
    const result = await accountKit.socialAuthentication.begin({
      provider,
      intent,
      current,
      clientChallenge: transaction.clientChallenge,
      purpose: input.purpose,
      proof: input.proof,
      context: { ally, params, request },
    })
    transaction.remember(result.state)
    return response.ok({ authorizationUrl: result.url })
  }

  async confirm({ params, request, session, ally, response }: HttpContext) {
    const provider = providerParam(params.provider)
    const { verificationToken, clientChallenge } =
      await request.validateUsing(socialConfirmValidator)
    const transaction = beginBrowserTransaction({ session }, clientChallenge)
    const result = await accountKit.socialAuthentication.beginConfirmation({
      provider,
      verificationToken,
      clientChallenge: transaction.clientChallenge,
      context: { ally, params, request },
    })
    transaction.remember(result.state)
    return response.ok({ authorizationUrl: result.url })
  }

  async verificationEntry({ response, params }: HttpContext) {
    response.header('Cache-Control', 'no-store')
    response.header('Referrer-Policy', 'no-referrer')
    return response.ok({ verificationToken: params.token })
  }

  async callback({ response, params, request, session, auth, ally, serialize }: HttpContext) {
    response.header('Cache-Control', 'no-store')
    response.header('Referrer-Policy', 'no-referrer')
    const provider = providerParam(params.provider)
    const { state, intent } = await request.validateUsing(socialCallbackValidator)
    const pending = pendingBrowserTransaction({ session }, state)
    const current = await currentIfAuthenticated({ auth, session })
    const result = await accountKit.socialAuthentication.callback({
      state,
      provider,
      callback: { ally, params, request },
      current,
      intent,
    })
    if (pending) forgetBrowserTransaction({ session })
    if ('continuation' in result) {
      if (pending) rememberBrowserContinuation({ session }, result.continuation, pending)
      return response.ok({ status: 'new', continuation: result.continuation })
    }
    return finishSocialCallback({ auth, session, response, serialize }, result, pending?.verifier)
  }

  async completeRegistration({ response, request, session, auth, serialize }: HttpContext) {
    response.header('Cache-Control', 'no-store')
    const { continuation, fullName, email } = await request.validateUsing(
      socialRegistrationValidator
    )
    const pending = pendingBrowserContinuation({ session }, continuation)
    const result = await accountKit.socialAuthentication.completeRegistration({
      continuation,
      email,
      registrationData: { fullName },
    })
    if (pending) {
      forgetBrowserContinuation({ session })
      return finishSocialCallback({ auth, session, response, serialize }, result, pending.verifier)
    }
    return response.ok(result)
  }
}
