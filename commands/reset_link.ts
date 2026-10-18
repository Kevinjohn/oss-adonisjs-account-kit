import { BaseCommand, args, flags } from '@adonisjs/core/ace'
import { AccountKit } from '../src/account_kit.js'
import type { OperatorResetLinkResult } from '../src/types.js'
import { BEARER_WARNING, writeFailure, writeResult, writeWarning } from './operator_output.js'

/** Operator password-reset link: no throttles; replaces the account's live reset link. */
export default class ResetLink extends BaseCommand {
  static commandName = 'account-kit:reset-link'
  static description = 'Issue a password-reset link for an account, replacing its live reset link'
  static options = { startApp: true }

  @args.string({ description: 'Email address of the account' })
  declare email: string

  @flags.boolean({ description: 'Print the reset link instead of emailing it' })
  declare print: boolean

  result: OperatorResetLinkResult | null = null
  failure: string | null = null

  async run(): Promise<void> {
    try {
      const kit = await this.app.container.make(AccountKit)
      const result = await kit.operator.resetLink({
        email: this.email,
        deliver: this.print ? 'print' : 'send',
      })
      this.result = result
      if (result.url) writeWarning(this, BEARER_WARNING)
      if (result.user.unverifiedEmail !== null && result.user.unverifiedEmail === result.user.email)
        writeWarning(
          this,
          'This account has not verified its email; completing the reset will activate it.'
        )
      writeResult(this, {
        result: this.print ? 'printed' : 'sent',
        userId: result.user.id,
        email: result.user.email,
        ...(result.url ? { url: result.url } : {}),
        ...(result.fault ? { fault: result.fault } : {}),
      })
      if (result.fault) {
        this.failure = result.fault.name
        this.logger.error(`Reset link committed but a follow-up failed: ${result.fault.message}`)
        this.exitCode = 1
      }
    } catch (error) {
      this.failure = writeFailure(this, error)
    }
  }
}
