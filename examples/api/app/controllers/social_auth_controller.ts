/* eslint-disable @unicorn/no-await-expression-member -- Keep each short HTTP action next to its service operation. */

import { createHash, randomBytes } from 'node:crypto'
import app from '@adonisjs/core/services/app'
import type { HttpContext } from '@adonisjs/core/http'
import {
  AccountKit,
  InvalidInputError,
  type SocialCallbackResult,
  type SocialBeginInput,
  type SocialProviderName,
} from 'adonisjs-account-kit'
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
  private async kit() {
    return app.container.make(AccountKit)
  }

  async redirect(ctx: HttpContext) {
    const provider = providerParam(ctx.params.provider)
    const intent = ctx.request.input('intent', 'login') as SocialBeginInput['intent']
    const current = intent === 'login' ? undefined : await currentIfAuthenticated(ctx)
    const browserVerifier = socialStrategy() === 'session' ? verifier() : undefined
    const clientChallenge = browserVerifier
      ? challenge(browserVerifier)
      : requiredString(ctx.request.input('clientChallenge'), 'clientChallenge')
    const result = await (
      await this.kit()
    ).socialAuthentication.begin({
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
    const result = await (
      await this.kit()
    ).socialAuthentication.beginConfirmation({
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
    const result = await (
      await this.kit()
    ).socialAuthentication.callback({
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
      const redeemed = await (
        await this.kit()
      ).socialAuthentication.redeemHandoff({
        code: result.handoffCode,
        verifier: browserVerifier,
        guard: sessionGuard(ctx),
      })
      rememberLastUsedMethod(ctx, redeemed.provider)
      return ctx.response.ok({ status: result.status, account: redeemed.account })
    }
    return ctx.response.ok(result)
  }

  async completeRegistration(ctx: HttpContext) {
    ctx.response.header('Cache-Control', 'no-store')
    const continuation = requiredString(ctx.request.input('continuation'), 'continuation')
    const { fullName } = await ctx.request.validateUsing(socialRegistrationValidator)
    const pending =
      socialStrategy() === 'session'
        ? (ctx.session.get('socialContinuation') as BrowserContinuation | undefined)
        : undefined
    if (socialStrategy() === 'session' && pending?.continuation !== continuation) {
      throw new InvalidInputError('Invalid social continuation')
    }
    const result = await (
      await this.kit()
    ).socialAuthentication.completeRegistration({
      continuation,
      email: ctx.request.input('email'),
      registrationData: { fullName },
    })
    if (pending?.continuation === continuation) {
      ctx.session.forget('socialContinuation')
      return this.finishCallback(ctx, result, pending.verifier)
    }
    return ctx.response.ok(result)
  }
}
