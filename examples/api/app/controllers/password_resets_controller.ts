import type { HttpContext } from '@adonisjs/core/http'
import { E_ACCOUNT_KIT_INVALID_TOKEN } from '@kevinjohn/adonisjs-account-kit'
import accountKit from '@kevinjohn/adonisjs-account-kit/services/main'
import { passwordValidator, recoveryRequestValidator } from '#validators/account_kit'
import { proofFailure, proofHeaders } from '#services/http_responses'
import { committedFollowUp } from '#services/committed_failure_diagnostic'

const acknowledgement = { message: 'If the account exists, instructions will be sent.' }

export default class PasswordResetsController {
  async request({ request, response, logger }: HttpContext) {
    const { email } = await request.validateUsing(recoveryRequestValidator)
    await committedFollowUp(logger, 'password_reset.request', () =>
      accountKit.passwordReset.request({ email, clientKey: request.ip() })
    )
    return response.accepted(acknowledgement)
  }

  async inspect({ response, params, request }: HttpContext) {
    proofHeaders({ response })
    const valid = await accountKit.passwordReset.inspect({ token: params.token })
    return valid
      ? response.ok({ valid: true })
      : proofFailure({ request, response }, 'E_ACCOUNT_KIT_INVALID_PASSWORD_TOKEN')
  }

  async complete({ response, request, logger, params }: HttpContext) {
    proofHeaders({ response })
    const { password } = await request.validateUsing(passwordValidator)
    try {
      await committedFollowUp(logger, 'password_reset.complete', () =>
        accountKit.passwordReset.reset({ token: params.token, password })
      )
      return response.accepted({ message: 'Password reset.' })
    } catch (error) {
      if (error instanceof E_ACCOUNT_KIT_INVALID_TOKEN)
        return proofFailure({ request, response }, 'E_ACCOUNT_KIT_INVALID_PASSWORD_TOKEN')
      throw error
    }
  }
}
