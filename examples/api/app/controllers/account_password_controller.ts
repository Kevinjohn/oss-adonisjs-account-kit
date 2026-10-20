import type { HttpContext } from '@adonisjs/core/http'
import accountKit from 'adonisjs-account-kit/services/main'
import { credentialChangeValidator } from '#validators/account_kit'
import { committedFollowUp } from '#services/committed_failure_diagnostic'

export default class AccountPasswordController {
  async update({ auth, request, response, logger }: HttpContext) {
    const actor = await auth.getUserOrFail()
    const { currentPassword, newPassword } = await request.validateUsing(credentialChangeValidator)
    await committedFollowUp(logger, 'account_password.change', () =>
      accountKit.emailPasswordManagement.changePassword({
        actorId: actor.id,
        currentPassword,
        newPassword,
      })
    )
    return response.ok({ changed: true })
  }
}
