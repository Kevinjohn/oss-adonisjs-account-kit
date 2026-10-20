import { BaseCommand, args, flags } from '@adonisjs/core/ace'
import {
  reportOperatorOutcome,
  writeFailure,
  writeResult,
} from '../../../commands/operator_output.js'
import { InvalidInputError } from '../../errors.js'
import { AccountAdmission } from '../service.js'

/** First administrator in one step: an operator invitation that lands its account approved. */
export default class BootstrapAdmission extends BaseCommand {
  static commandName = 'account-kit:admission:bootstrap'
  static description =
    'Invite an address as an operator and approve the account it creates, printing the link'
  static options = { startApp: true }

  @args.string({ description: 'Email address to invite' })
  declare email: string

  @flags.string({ description: 'Role stored on the invitation (1-64 characters)' })
  declare role?: string

  @flags.boolean({ description: 'Delete the waiting approval for the address instead' })
  declare cancel: boolean

  failure: string | null = null

  async run(): Promise<void> {
    try {
      const admission = await this.app.container.make(AccountAdmission)
      if (this.cancel) {
        const cancelled = await admission.operator.cancelBootstrap({ email: this.email })
        writeResult(this, { result: cancelled ? 'cancelled' : 'none', email: this.email })
        return
      }
      if (this.role === undefined) throw new InvalidInputError('Invalid role')
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
    } catch (error) {
      this.failure = writeFailure(this, error)
    }
  }
}
