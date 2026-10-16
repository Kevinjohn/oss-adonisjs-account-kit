import app from '@adonisjs/core/services/app'
import type { HttpContext } from '@adonisjs/core/http'
import { AccountKit, DeliveryError, PostCommitError } from 'adonisjs-account-kit'
import { credentialChangeValidator } from '#validators/account_kit'
import { reportCommittedFailure } from '#services/committed_failure_diagnostic'

export default class AccountPasswordController {
  async update({ auth, request, response, logger }: HttpContext) {
    const actor = await auth.getUserOrFail()
    const { currentPassword, newPassword } = await request.validateUsing(credentialChangeValidator)
    const kit = await app.container.make(AccountKit)
    try {
      await kit.emailPasswordManagement.changePassword({
        actorId: actor.id,
        currentPassword,
        newPassword,
      })
    } catch (error) {
      if (!(error instanceof DeliveryError || error instanceof PostCommitError)) throw error
      reportCommittedFailure(logger, error, 'account_password.change')
    }
    return response.ok({ changed: true })
  }
}
