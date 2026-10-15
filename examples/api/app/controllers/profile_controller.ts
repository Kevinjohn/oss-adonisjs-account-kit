import app from '@adonisjs/core/services/app'
import {
  AccountKit,
  DeliveryError,
  InvalidTokenError,
  PostCommitError,
  type AccountUser,
} from 'adonisjs-account-kit'
import type { HttpContext } from '@adonisjs/core/http'
import { accountInput } from '#middleware/account_access_middleware'
import { profileUpdateValidator } from '#validators/account_kit'
import { proofFailure, proofHeaders } from '#services/http_responses'

function safeAccount(user: AccountUser) {
  return {
    id: user.id,
    email: user.email,
    unverifiedEmail: user.unverifiedEmail,
    hasPassword: user.hasPassword,
    active: user.unverifiedEmail === null || user.unverifiedEmail !== user.email,
  }
}

export default class ProfileController {
  async show(ctx: HttpContext) {
    const input = accountInput(ctx)
    const kit = await app.container.make(AccountKit)
    return ctx.serialize(await kit.authentication.current(input))
  }

  async update(ctx: HttpContext) {
    const actor = await ctx.auth.getUserOrFail()
    const { currentPassword, email, fullName } =
      await ctx.request.validateUsing(profileUpdateValidator)
    const kit = await app.container.make(AccountKit)
    try {
      const updated = await kit.emailPasswordManagement.updateProfile({
        actorId: actor.id,
        currentPassword,
        ...(email === undefined ? {} : { email }),
        ...(fullName === undefined ? {} : { registrationData: { fullName } }),
      })
      return ctx.serialize(safeAccount(updated))
    } catch (error) {
      if (!(error instanceof DeliveryError || error instanceof PostCommitError)) throw error
      return ctx.response.ok({ updated: true })
    }
  }

  async inspectEmailChange(ctx: HttpContext) {
    proofHeaders(ctx)
    const kit = await app.container.make(AccountKit)
    if (!(await kit.emailPasswordManagement.inspectEmailChange({ token: ctx.params.token }))) {
      return proofFailure(ctx, 'E_INVALID_EMAIL_TOKEN')
    }
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
        return proofFailure(ctx, 'E_INVALID_EMAIL_TOKEN')
      }
      if (error instanceof DeliveryError || error instanceof PostCommitError) {
        return ctx.response.ok({ changed: true })
      }
      throw error
    }
  }
}
