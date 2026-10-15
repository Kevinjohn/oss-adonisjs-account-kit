import { BaseCommand, flags } from '@adonisjs/core/ace'
import { AccountKit } from '../src/account_kit.js'

/** Booted, read-only inventory for a proposed password-login retirement. */
export default class RetirementImpact extends BaseCommand {
  static commandName = 'account-kit:retirement-impact'
  static description = 'Count accounts affected by retiring password login'
  static options = { startApp: true }

  @flags.boolean({ description: 'Return the structured result without printing it' })
  declare quiet: boolean

  impact: Awaited<ReturnType<AccountKit['authentication']['retirementImpact']>> | null = null
  failure: 'inventory_unavailable' | null = null

  async run(): Promise<void> {
    try {
      const kit = await this.app.container.make(AccountKit)
      this.impact = await kit.authentication.retirementImpact({ passwordLogin: false })
      if (!this.quiet) this.logger.info(JSON.stringify(this.impact))
    } catch {
      this.failure = 'inventory_unavailable'
      this.exitCode = 1
      if (!this.quiet)
        this.logger.error(
          'Account inventory unavailable; verify Account Kit configuration and database access'
        )
    }
  }
}
