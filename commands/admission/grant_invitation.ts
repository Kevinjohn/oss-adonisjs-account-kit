import { BaseCommand, args, flags } from '@adonisjs/core/ace'
import { completeOperatorCommand, writeResult } from '../operator_output.ts'
import { operatorAdmission } from '../../src/admission/operator_service.ts'
import type { AdmissionRecord } from '../../src/admission/types.ts'

/** Operator invitation evidence for an account that exists already. The role grants nothing. */
export default class GrantInvitationEvidence extends BaseCommand {
  static commandName = 'account-kit:admission:grant-invitation'
  static description = 'Record invitation evidence for an existing account as an operator'
  static options = { startApp: true }

  @args.string({ description: 'Email address of the account' })
  declare email: string

  @flags.string({ description: 'Role stored on the record only; it grants nothing' })
  declare role?: string

  result: AdmissionRecord | null = null
  failure: string | null = null

  /** @throws {AggregateError} If transaction work and cleanup fail before a commit is confirmed. */
  async run(): Promise<void> {
    const admission = await operatorAdmission(this)
    if (!admission) return
    this.result = await admission.operator.grantInvitation({
      email: this.email,
      ...(this.role === undefined ? {} : { role: this.role }),
    })
    writeResult(this, {
      result: 'granted',
      userId: this.result.userId,
      email: this.result.email,
      role: this.result.invitation?.role ?? null,
    })
  }

  completed(): boolean {
    return completeOperatorCommand(this)
  }
}
