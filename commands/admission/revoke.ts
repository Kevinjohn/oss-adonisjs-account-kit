import { BaseCommand, args } from '@adonisjs/core/ace'
import { completeOperatorCommand, writeResult } from '../operator_output.ts'
import { operatorAdmission } from '../../src/admission/operator_admission.ts'
import type { AdmissionRecord } from '../../src/admission/types.ts'

/** Operator revocation: the account keeps signing in but no longer passes the admission gate. */
export default class RevokeAdmission extends BaseCommand {
  static commandName = 'account-kit:admission:revoke'
  static description = 'Revoke an approved account as an operator'
  static options = { startApp: true }

  @args.string({ description: 'Email address of the account' })
  declare email: string

  result: AdmissionRecord | null = null
  failure: string | null = null

  /** @throws {AggregateError} If transaction work and cleanup fail before a commit is confirmed. */
  async run(): Promise<void> {
    const admission = await operatorAdmission(this)
    if (!admission) return
    this.result = await admission.operator.revoke({ email: this.email })
    writeResult(this, {
      result: 'revoked',
      userId: this.result.userId,
      email: this.result.email,
    })
  }

  completed(): boolean {
    return completeOperatorCommand(this)
  }
}
