import app from '@adonisjs/core/services/app'
import type { HttpContext } from '@adonisjs/core/http'
import { AccountKit, DeliveryError, InvalidTokenError, PostCommitError } from 'adonisjs-account-kit'
import { verificationCompleteValidator } from '#validators/account_kit'
import { proofFailure, proofHeaders } from '#services/http_responses'
import { reportCommittedFailure } from '#services/committed_failure_diagnostic'

export default class EmailVerificationsController {
  async send({ auth, response, logger }: HttpContext) {
    const actor = await auth.getUserOrFail()
    const kit = await app.container.make(AccountKit)
    try {
      const result = await kit.emailVerification.send({ userId: actor.id })
      return response.ok({ result })
    } catch (error) {
      if (error instanceof DeliveryError || error instanceof PostCommitError) {
        reportCommittedFailure(logger, error, 'email_verification.send')
        return response.ok({ result: 'sent' })
      }
      throw error
    }
  }

  async inspect(ctx: HttpContext) {
    proofHeaders(ctx)
    const kit = await app.container.make(AccountKit)
    if (!(await kit.emailVerification.inspect({ token: ctx.params.token }))) {
      return proofFailure(ctx, 'E_ACCOUNT_KIT_INVALID_EMAIL_TOKEN')
    }
    return ctx.response.ok({ confirmation: true })
  }

  async complete(ctx: HttpContext) {
    proofHeaders(ctx)
    const { password } = await ctx.request.validateUsing(verificationCompleteValidator)
    const kit = await app.container.make(AccountKit)
    try {
      const result = await kit.emailVerification.complete({ token: ctx.params.token, password })
      return ctx.response.ok({ result })
    } catch (error) {
      if (error instanceof InvalidTokenError)
        return proofFailure(ctx, 'E_ACCOUNT_KIT_INVALID_EMAIL_TOKEN')
      if (error instanceof DeliveryError || error instanceof PostCommitError) {
        reportCommittedFailure(ctx.logger, error, 'email_verification.complete')
        return ctx.response.ok({ result: 'verified' })
      }
      throw error
    }
  }
}
