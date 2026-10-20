import type { HttpContext } from '@adonisjs/core/http'
import { InvalidTokenError } from 'adonisjs-account-kit'
import accountKit from 'adonisjs-account-kit/services/main'
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

  async inspect(ctx: HttpContext) {
    proofHeaders(ctx)
    const valid = await accountKit.passwordReset.inspect({ token: ctx.params.token })
    return valid
      ? ctx.response.ok({ valid: true })
      : proofFailure(ctx, 'E_ACCOUNT_KIT_INVALID_PASSWORD_TOKEN')
  }

  async complete(ctx: HttpContext) {
    proofHeaders(ctx)
    const { password } = await ctx.request.validateUsing(passwordValidator)
    try {
      await committedFollowUp(ctx.logger, 'password_reset.complete', () =>
        accountKit.passwordReset.reset({ token: ctx.params.token, password })
      )
      return ctx.response.accepted({ message: 'Password reset.' })
    } catch (error) {
      if (error instanceof InvalidTokenError)
        return proofFailure(ctx, 'E_ACCOUNT_KIT_INVALID_PASSWORD_TOKEN')
      throw error
    }
  }
}
