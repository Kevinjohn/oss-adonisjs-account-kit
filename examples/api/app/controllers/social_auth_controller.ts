/* eslint-disable @unicorn/no-await-expression-member -- Keep each short HTTP action next to its service operation. */

import { createHash, randomBytes } from 'node:crypto'
import type { HttpContext } from '@adonisjs/core/http'
import {
  InvalidInputError,
  type SocialCallbackResult,
  type SocialBeginInput,
  type SocialProviderName,
} from 'adonisjs-account-kit'
import accountKit from 'adonisjs-account-kit/services/main'
import User from '#models/user'
import UserTransformer from '#transformers/user_transformer'
import { sessionGuard } from '#services/account_kit_guards'
import { rememberLastUsedMethod } from '#services/last_used_method'
import { currentIfAuthenticated, requiredString, socialStrategy } from '#services/social_request'
import { socialRegistrationValidator } from '#validators/user'

type BrowserTransaction = { state: string; verifier: string }
type BrowserContinuation = { continuation: string; verifier: string }

const verifier = () => randomBytes(32).toString('base64url')
const challenge = (value: string) => createHash('sha256').update(value).digest('base64url')

function providerParam(value: string): SocialProviderName {
  if (value !== 'google' && value !== 'github') throw new InvalidInputError('Unknown provider')
  return value
}

export default class SocialAuthController {
  async redirect(ctx: HttpContext) {
    const provider = providerParam(ctx.params.provider)
    const intent = ctx.request.input('intent', 'login') as SocialBeginInput['intent']
    const current = intent === 'login' ? undefined : await currentIfAuthenticated(ctx)
    const browserVerifier = socialStrategy() === 'session' ? verifier() : undefined
    const clientChallenge = browserVerifier
      ? challenge(browserVerifier)
      : requiredString(ctx.request.input('clientChallenge'), 'clientChallenge')
    const result = await accountKit.socialAuthentication.begin({
      provider,
      intent,
      current,
      clientChallenge,
      purpose: ctx.request.input('purpose'),
      proof: ctx.request.input('proof'),
      context: ctx,
    })
    if (browserVerifier) {
      ctx.session.put('socialTransaction', { state: result.state, verifier: browserVerifier })
    }
    return ctx.response.ok({ authorizationUrl: result.url })
  }

  async confirm(ctx: HttpContext) {
    const provider = providerParam(ctx.params.provider)
    const verificationToken = requiredString(
      ctx.request.input('verificationToken'),
      'verificationToken'
    )
    const browserVerifier = socialStrategy() === 'session' ? verifier() : undefined
    const clientChallenge = browserVerifier
      ? challenge(browserVerifier)
      : requiredString(ctx.request.input('clientChallenge'), 'clientChallenge')
    const result = await accountKit.socialAuthentication.beginConfirmation({
      provider,
      verificationToken,
      clientChallenge,
      context: ctx,
    })
    if (browserVerifier) {
      ctx.session.put('socialTransaction', { state: result.state, verifier: browserVerifier })
    }
    return ctx.response.ok({ authorizationUrl: result.url })
  }

  async verificationEntry(ctx: HttpContext) {
    ctx.response.header('Cache-Control', 'no-store')
    ctx.response.header('Referrer-Policy', 'no-referrer')
    const verificationToken = requiredString(ctx.params.token, 'verificationToken')
    return ctx.response.ok({ verificationToken })
  }

  async callback(ctx: HttpContext) {
    ctx.response.header('Cache-Control', 'no-store')
    ctx.response.header('Referrer-Policy', 'no-referrer')
    const provider = providerParam(ctx.params.provider)
    const state = requiredString(ctx.request.input('state'), 'state')
    const browser = socialStrategy() === 'session'
    const pending = browser
      ? (ctx.session.get('socialTransaction') as BrowserTransaction | undefined)
      : undefined
    if (browser && pending?.state !== state)
      throw new InvalidInputError('Invalid social transaction')
    const current = await currentIfAuthenticated(ctx)
    const result = await accountKit.socialAuthentication.callback({
      state,
      provider,
      callback: ctx,
      current,
      intent: ctx.request.input('intent'),
    })
    if (browser) ctx.session.forget('socialTransaction')
    if ('continuation' in result) {
      if (pending) {
        ctx.session.put('socialContinuation', {
          continuation: result.continuation,
          verifier: pending.verifier,
        })
      }
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
        guard: sessionGuard(ctx),
      })
      const user = await User.findOrFail(redeemed.account.id)
      rememberLastUsedMethod(ctx, redeemed.provider)
      return ctx.serialize({ status: result.status, user: UserTransformer.transform(user) })
    }
    return ctx.response.ok(result)
  }

  async completeRegistration(ctx: HttpContext) {
    ctx.response.header('Cache-Control', 'no-store')
    const continuation = requiredString(ctx.request.input('continuation'), 'continuation')
    const { fullName, email } = await ctx.request.validateUsing(socialRegistrationValidator)
    const pending =
      socialStrategy() === 'session'
        ? (ctx.session.get('socialContinuation') as BrowserContinuation | undefined)
        : undefined
    if (socialStrategy() === 'session' && pending?.continuation !== continuation) {
      throw new InvalidInputError('Invalid social continuation')
    }
    const result = await accountKit.socialAuthentication.completeRegistration({
      continuation,
      email,
      registrationData: { fullName },
    })
    if (pending?.continuation === continuation) {
      ctx.session.forget('socialContinuation')
      return this.finishCallback(ctx, result, pending.verifier)
    }
    return ctx.response.ok(result)
  }
}
