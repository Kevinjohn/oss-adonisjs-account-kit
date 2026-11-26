import {
  E_ACCOUNT_KIT_DELIVERY,
  E_ACCOUNT_KIT_POST_COMMIT,
  type AccountUser,
} from '@kevinjohn/adonisjs-account-kit'
import accountKit from '@kevinjohn/adonisjs-account-kit/services/main'
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
  async show({ auth, session, serialize }: HttpContext) {
    const input = accountInput({ auth, session })
    return serialize(await accountKit.authentication.current(input))
  }

  async update({ auth, request, serialize, logger, response }: HttpContext) {
    const actor = await auth.getUserOrFail()
    const { currentPassword, email, fullName } = await request.validateUsing(profileUpdateValidator)
    try {
      const updated = await accountKit.emailPasswordManagement.updateProfile({
        actorId: actor.id,
        currentPassword,
        ...(email === undefined ? {} : { email }),
        ...(fullName === undefined ? {} : { registrationData: { fullName } }),
      })
      return serialize(safeAccount(updated))
    } catch (error) {
      if (!(error instanceof E_ACCOUNT_KIT_DELIVERY || error instanceof E_ACCOUNT_KIT_POST_COMMIT))
        throw error
      reportCommittedFailure(logger, error, 'profile.update')
      return response.ok({ updated: true })
    }
  }
}
