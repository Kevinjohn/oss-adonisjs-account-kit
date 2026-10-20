import { DeliveryError, PostCommitError, type AccountUser } from 'adonisjs-account-kit'
import accountKit from 'adonisjs-account-kit/services/main'
import type { HttpContext } from '@adonisjs/core/http'
import { accountInput } from '#middleware/account_access_middleware'
import { profileUpdateValidator } from '#validators/account_kit'
import { reportCommittedFailure } from '#services/committed_failure_diagnostic'

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
    return ctx.serialize(await accountKit.authentication.current(input))
  }

  async update(ctx: HttpContext) {
    const actor = await ctx.auth.getUserOrFail()
    const { currentPassword, email, fullName } =
      await ctx.request.validateUsing(profileUpdateValidator)
    try {
      const updated = await accountKit.emailPasswordManagement.updateProfile({
        actorId: actor.id,
        currentPassword,
        ...(email === undefined ? {} : { email }),
        ...(fullName === undefined ? {} : { registrationData: { fullName } }),
      })
      return ctx.serialize(safeAccount(updated))
    } catch (error) {
      if (!(error instanceof DeliveryError || error instanceof PostCommitError)) throw error
      reportCommittedFailure(ctx.logger, error, 'profile.update')
      return ctx.response.ok({ updated: true })
    }
  }
}
