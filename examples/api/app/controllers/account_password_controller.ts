import type { HttpContext } from '@adonisjs/core/http'
import { PostCommitError, passwordChangeRevision } from 'adonisjs-account-kit'
import accountKit from 'adonisjs-account-kit/services/main'
import { credentialChangeValidator } from '#validators/account_kit'
import { accountInput } from '#services/account_input'
import { authStrategy } from '#services/auth_strategy'
import { reportCommittedFailure } from '#services/committed_failure_diagnostic'

export default class AccountPasswordController {
  async update(ctx: HttpContext) {
    const { request, response, logger } = ctx
    const input = accountInput(ctx)
    const { currentPassword, newPassword } = await request.validateUsing(credentialChangeValidator)
    // Keep the caller's own token; every other sign-in ends.
    const keepCurrent = 'tokenId' in input && input.tokenId ? { tokenId: input.tokenId } : {}
    let revision: string | null
    try {
      const changed = await accountKit.emailPasswordManagement.changePassword({
        actorId: input.userId,
        currentPassword,
        newPassword,
        keepCurrent,
      })
      revision = changed.revision
    } catch (error) {
      // A follow-up failed after commit: the change stands, so keep this session on it.
      const committed = passwordChangeRevision(error)
      if (!(error instanceof PostCommitError) || committed === undefined) throw error
      reportCommittedFailure(logger, error, 'account_password.change')
      revision = committed
    }
    if (authStrategy() === 'session') ctx.session.put('accountKitRevision', revision ?? '')
    return response.ok({ changed: true })
  }
}
