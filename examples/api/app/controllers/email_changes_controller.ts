import {
  E_ACCOUNT_KIT_DELIVERY,
  E_ACCOUNT_KIT_INVALID_TOKEN,
  E_ACCOUNT_KIT_POST_COMMIT,
} from '@kevinjohn/adonisjs-account-kit'
import accountKit from '@kevinjohn/adonisjs-account-kit/services/main'
import type { HttpContext } from '@adonisjs/core/http'
import { proofFailure, proofHeaders } from '#services/http_responses'
import { reportCommittedFailure } from '#services/committed_failure_diagnostic'

export default class EmailChangesController {
  async inspectEmailChange({ response, params, request }: HttpContext) {
    proofHeaders({ response })
    if (!(await accountKit.emailPasswordManagement.inspectEmailChange({ token: params.token }))) {
      return proofFailure({ request, response }, 'E_ACCOUNT_KIT_INVALID_EMAIL_TOKEN')
    }
    return response.ok({ confirmation: true })
  }

  async completeEmailChange({ response, params, request, logger }: HttpContext) {
    proofHeaders({ response })
    try {
      const user = await accountKit.emailPasswordManagement.completeEmailChange({
        token: params.token,
      })
      return response.ok({
        email: user.email,
        verified: user.unverifiedEmail === null || user.unverifiedEmail !== user.email,
      })
    } catch (error) {
      if (error instanceof E_ACCOUNT_KIT_INVALID_TOKEN) {
        return proofFailure({ request, response }, 'E_ACCOUNT_KIT_INVALID_EMAIL_TOKEN')
      }
      if (error instanceof E_ACCOUNT_KIT_DELIVERY || error instanceof E_ACCOUNT_KIT_POST_COMMIT) {
        reportCommittedFailure(logger, error, 'email_change.complete')
        return response.ok({ changed: true })
      }
      throw error
    }
  }
}
