import { BaseCommand, args, flags } from '@adonisjs/core/ace'
import { AccountKit } from '../src/account_kit.ts'
import { isActiveAccount } from '../src/account_projection.ts'
import type { OperatorResetLinkResult } from '../src/types.ts'
import { reportOperatorOutcome, completeOperatorCommand } from './operator_output.ts'

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

  /** @throws {AggregateError} If transaction work and cleanup fail before a commit is confirmed. */
  async run(): Promise<void> {
    const kit = await this.app.container.make(AccountKit)
    const result = await kit.operator.resetLink({
      email: this.email,
      deliver: this.print ? 'print' : 'send',
    })
    this.result = result
    const unverified = !isActiveAccount(result.user)
    this.failure = reportOperatorOutcome(this, {
      result,
      printed: this.print,
      fields: { userId: result.user.id, email: result.user.email },
      faultLabel: 'Reset link',
      warnings: unverified
        ? ['This account has not verified its email; completing the reset will activate it.']
        : [],
    })
  }

  completed(): boolean {
    return completeOperatorCommand(this)
  }
}
