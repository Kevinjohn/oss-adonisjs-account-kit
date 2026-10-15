import app from '@adonisjs/core/services/app'
import type { HttpContext } from '@adonisjs/core/http'
import { AccountKit, DeliveryError, InvalidTokenError, PostCommitError } from 'adonisjs-account-kit'
import { passwordValidator, recoveryRequestValidator } from '#validators/account_kit'
import { proofFailure, proofHeaders } from '#services/http_responses'

const acknowledgement = { message: 'If the account exists, instructions will be sent.' }

export default class PasswordResetsController {
  async request({ request, response }: HttpContext) {
    const { email } = await request.validateUsing(recoveryRequestValidator)
    const kit = await app.container.make(AccountKit)
    try {
      await kit.passwordReset.request({ email, clientKey: request.ip() })
    } catch (error) {
      if (!(error instanceof DeliveryError || error instanceof PostCommitError)) throw error
    }
    return response.accepted(acknowledgement)
  }

  async inspect(ctx: HttpContext) {
    proofHeaders(ctx)
    const kit = await app.container.make(AccountKit)
    const valid = await kit.passwordReset.inspect({ token: ctx.params.token })
    return valid ? ctx.response.ok({ valid: true }) : proofFailure(ctx, 'E_INVALID_PASSWORD_TOKEN')
  }

  async complete(ctx: HttpContext) {
    proofHeaders(ctx)
    const { password } = await ctx.request.validateUsing(passwordValidator)
    const kit = await app.container.make(AccountKit)
    try {
      await kit.passwordReset.reset({ token: ctx.params.token, password })
      return ctx.response.accepted({ message: 'Password reset.' })
    } catch (error) {
      if (error instanceof InvalidTokenError) return proofFailure(ctx, 'E_INVALID_PASSWORD_TOKEN')
      if (error instanceof PostCommitError || error instanceof DeliveryError) {
        return ctx.response.accepted({ message: 'Password reset.' })
      }
      throw error
    }
  }
}
