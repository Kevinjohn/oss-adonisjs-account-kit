import { BaseCommand, args } from '@adonisjs/core/ace'
import { writeFailure, writeResult } from '../../../commands/operator_output.js'
import { AccountAdmission } from '../service.js'
import type { AdmissionRecord } from '../types.js'

/** Operator revocation: the account keeps signing in but no longer passes the admission gate. */
export default class RevokeAdmission extends BaseCommand {
  static commandName = 'account-kit:admission:revoke'
  static description = 'Revoke an approved account as an operator'
  static options = { startApp: true }

  @args.string({ description: 'Email address of the account' })
  declare email: string

  result: AdmissionRecord | null = null
  failure: string | null = null

  async run(): Promise<void> {
    try {
      const admission = await this.app.container.make(AccountAdmission)
      this.result = await admission.operator.revoke({ email: this.email })
      writeResult(this, {
        result: 'revoked',
        userId: this.result.userId,
        email: this.result.email,
      })
    } catch (error) {
      this.failure = writeFailure(this, error)
    }
  }
}
