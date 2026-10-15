import app from '@adonisjs/core/services/app'
import { AccountKit, DeliveryError, InvalidTokenError, PostCommitError } from 'adonisjs-account-kit'
import type { HttpContext } from '@adonisjs/core/http'
import { accountInput } from '#middleware/account_access_middleware'
import { emailChangeValidator } from '#validators/account_kit'
import { proofFailure, proofHeaders } from '#services/http_responses'

export default class ProfileController {
  async show(ctx: HttpContext) {
    const input = accountInput(ctx)
    const kit = await app.container.make(AccountKit)
    return ctx.serialize(await kit.authentication.current(input))
  }

  async requestEmailChange({ auth, request, response }: HttpContext) {
    const actor = await auth.getUserOrFail()
    const { currentPassword, newEmail } = await request.validateUsing(emailChangeValidator)
    const kit = await app.container.make(AccountKit)
    try {
      await kit.emailPasswordManagement.requestEmailChange({
        actorId: actor.id,
        currentPassword,
        newEmail,
      })
    } catch (error) {
      if (!(error instanceof DeliveryError || error instanceof PostCommitError)) throw error
    }
    return response.accepted({ requested: true })
  }

  async inspectEmailChange(ctx: HttpContext) {
    proofHeaders(ctx)
    return ctx.response.ok({ confirmation: true })
  }

  async completeEmailChange(ctx: HttpContext) {
    proofHeaders(ctx)
    const kit = await app.container.make(AccountKit)
    try {
      const user = await kit.emailPasswordManagement.completeEmailChange({
        token: ctx.params.token,
      })
      return ctx.response.ok({
        email: user.email,
        verified: user.unverifiedEmail === null || user.unverifiedEmail !== user.email,
      })
    } catch (error) {
      if (error instanceof InvalidTokenError) {
        return proofFailure(ctx, 'E_ACCOUNT_KIT_INVALID_TOKEN')
      }
      if (error instanceof DeliveryError || error instanceof PostCommitError) {
        return ctx.response.ok({ changed: true })
      }
      throw error
    }
  }
}
