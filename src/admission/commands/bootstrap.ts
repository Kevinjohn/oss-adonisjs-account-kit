import { BaseCommand, args, flags } from '@adonisjs/core/ace'
import {
  reportOperatorOutcome,
  completeOperatorCommand,
  writeResult,
} from '../../../commands/operator_output.js'
import {
  E_ACCOUNT_KIT_BOOTSTRAP_APPROVAL_CHANGED,
  E_ACCOUNT_KIT_INVALID_INPUT,
} from '../../errors.js'
import { invitationRoleLength } from '../../invitation_input.js'
import { AccountAdmission } from '../service.js'

/** First administrator in one step: an operator invitation that lands its account approved. */
export default class BootstrapAdmission extends BaseCommand {
  static commandName = 'account-kit:admission:bootstrap'
  static description =
    'Invite an address as an operator and approve the account it creates, printing the link'
  static options = { startApp: true }

  @args.string({ description: 'Email address to invite' })
  declare email: string

  @flags.string({
    description: `Role stored on the invitation (${invitationRoleLength.minLength}-${invitationRoleLength.maxLength} characters)`,
  })
  declare role?: string

  @flags.boolean({ description: 'Delete the waiting approval for the address instead' })
  declare cancel: boolean

  failure: string | null = null

  async run(): Promise<void> {
    const admission = await this.app.container.make(AccountAdmission)
    if (this.cancel) {
      const cancelled = await admission.operator.cancelBootstrap({ email: this.email })
      writeResult(this, { result: cancelled ? 'cancelled' : 'none', email: this.email })
      return
    }
    if (this.role === undefined) throw new E_ACCOUNT_KIT_INVALID_INPUT('Invalid role')
    const result = await admission.operator.bootstrap({ email: this.email, role: this.role })
    this.failure = reportOperatorOutcome(this, {
      result,
      printed: true,
      fields: {
        id: result.invitation.id,
        email: result.invitation.email,
        role: result.invitation.role,
        expiresAt: result.invitation.expiresAt.toISO(),
        approval: 'approved',
      },
      faultLabel: 'Invitation',
    })
  }

  completed(): boolean {
    if (this.error instanceof E_ACCOUNT_KIT_BOOTSTRAP_APPROVAL_CHANGED) {
      const { code, message: diagnostic } = E_ACCOUNT_KIT_BOOTSTRAP_APPROVAL_CHANGED
      this.logger.error(`${code}: ${diagnostic}`)
      this.failure = this.error.code
      return true
    }
    return completeOperatorCommand(this)
  }
}
