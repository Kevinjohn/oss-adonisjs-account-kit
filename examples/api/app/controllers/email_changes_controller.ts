import { DeliveryError, InvalidTokenError, PostCommitError } from 'adonisjs-account-kit'
import accountKit from 'adonisjs-account-kit/services/main'
import type { HttpContext } from '@adonisjs/core/http'
import { proofFailure, proofHeaders } from '#services/http_responses'
import { reportCommittedFailure } from '#services/committed_failure_diagnostic'

export default class EmailChangesController {
  async inspectEmailChange(ctx: HttpContext) {
    proofHeaders(ctx)
    if (
      !(await accountKit.emailPasswordManagement.inspectEmailChange({ token: ctx.params.token }))
    ) {
      return proofFailure(ctx, 'E_ACCOUNT_KIT_INVALID_EMAIL_TOKEN')
    }
    return ctx.response.ok({ confirmation: true })
  }

  async completeEmailChange(ctx: HttpContext) {
    proofHeaders(ctx)
    try {
      const user = await accountKit.emailPasswordManagement.completeEmailChange({
        token: ctx.params.token,
      })
      return ctx.response.ok({
        email: user.email,
        verified: user.unverifiedEmail === null || user.unverifiedEmail !== user.email,
      })
    } catch (error) {
      if (error instanceof InvalidTokenError) {
        return proofFailure(ctx, 'E_ACCOUNT_KIT_INVALID_EMAIL_TOKEN')
      }
      if (error instanceof DeliveryError || error instanceof PostCommitError) {
        reportCommittedFailure(ctx.logger, error, 'email_change.complete')
        return ctx.response.ok({ changed: true })
      }
      throw error
    }
  }
}
