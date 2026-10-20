import { BaseCommand, args } from '@adonisjs/core/ace'
import { writeFailure, writeResult } from '../../../commands/operator_output.js'
import { AccountAdmission } from '../service.js'
import type { AdmissionRecord } from '../types.js'

/** Operator approval: the first administrator, or recovery of a locked-out one. */
export default class ApproveAdmission extends BaseCommand {
  static commandName = 'account-kit:admission:approve'
  static description = 'Approve an account as an operator, for the first administrator or recovery'
  static options = { startApp: true }

  @args.string({ description: 'Email address of the account' })
  declare email: string

  result: AdmissionRecord | null = null
  failure: string | null = null

  async run(): Promise<void> {
    try {
      const admission = await this.app.container.make(AccountAdmission)
      this.result = await admission.operator.approve({ email: this.email })
      writeResult(this, {
        result: 'approved',
        userId: this.result.userId,
        email: this.result.email,
      })
    } catch (error) {
      this.failure = writeFailure(this, error)
    }
  }
}
