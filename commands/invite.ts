import { BaseCommand, args, flags } from '@adonisjs/core/ace'
import { AccountKit } from '../src/account_kit.js'
import type { OperatorInviteResult } from '../src/types.js'
import { reportOperatorOutcome, writeFailure } from './operator_output.js'

/** Operator invitation: no actor authorization, replaces any invitation pending for the address. */
export default class InviteAccount extends BaseCommand {
  static commandName = 'account-kit:invite'
  static description = 'Invite an email address as an operator, replacing any pending invitation'
  static options = { startApp: true }

  @args.string({ description: 'Email address to invite' })
  declare email: string

  @flags.string({ description: 'Role stored on the invitation (1-64 characters)', required: true })
  declare role: string

  @flags.boolean({ description: 'Print the acceptance link instead of emailing it' })
  declare print: boolean

  result: OperatorInviteResult | null = null
  failure: string | null = null

  async run(): Promise<void> {
    try {
      const kit = await this.app.container.make(AccountKit)
      const result = await kit.operator.invite({
        email: this.email,
        role: this.role,
        deliver: this.print ? 'print' : 'send',
      })
      this.result = result
      this.failure = reportOperatorOutcome(this, {
        result,
        printed: this.print,
        fields: {
          id: result.invitation.id,
          email: result.invitation.email,
          role: result.invitation.role,
          expiresAt: result.invitation.expiresAt.toISO(),
        },
        faultLabel: 'Invitation',
      })
    } catch (error) {
      this.failure = writeFailure(this, error)
    }
  }
}
