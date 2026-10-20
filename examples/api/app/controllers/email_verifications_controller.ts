import type { HttpContext } from '@adonisjs/core/http'
import { InvalidTokenError } from 'adonisjs-account-kit'
import accountKit from 'adonisjs-account-kit/services/main'
import { passwordValidator } from '#validators/account_kit'
import { proofFailure, proofHeaders } from '#services/http_responses'
import { committedFollowUp } from '#services/committed_failure_diagnostic'

export default class EmailVerificationsController {
  async send({ auth, response, logger }: HttpContext) {
    const actor = await auth.getUserOrFail()
    const result = await committedFollowUp(logger, 'email_verification.send', () =>
      accountKit.emailVerification.send({ userId: actor.id })
    )
    return response.ok({ result: result ?? 'sent' })
  }

  async inspect(ctx: HttpContext) {
    proofHeaders(ctx)
    if (!(await accountKit.emailVerification.inspect({ token: ctx.params.token }))) {
      return proofFailure(ctx, 'E_ACCOUNT_KIT_INVALID_EMAIL_TOKEN')
    }
    return ctx.response.ok({ confirmation: true })
  }

  async complete(ctx: HttpContext) {
    proofHeaders(ctx)
    const { password } = await ctx.request.validateUsing(passwordValidator)
    try {
      const result = await committedFollowUp(ctx.logger, 'email_verification.complete', () =>
        accountKit.emailVerification.complete({ token: ctx.params.token, password })
      )
      return ctx.response.ok({ result: result ?? 'verified' })
    } catch (error) {
      if (error instanceof InvalidTokenError)
        return proofFailure(ctx, 'E_ACCOUNT_KIT_INVALID_EMAIL_TOKEN')
      throw error
    }
  }
}
