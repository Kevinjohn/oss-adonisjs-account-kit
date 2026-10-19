import { BaseCommand, flags } from '@adonisjs/core/ace'
import { AccountKit } from '../src/account_kit.js'
import type { SocialProviderName } from '../src/types.js'

/** Parse `--providers`: absent keeps every configured provider; `none` or an empty list retires them all. */
function parseProviders(value?: string): SocialProviderName[] | undefined {
  if (value === undefined) return undefined
  if (value.trim() === 'none') return []
  return value
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean) as SocialProviderName[]
}

/** Booted, read-only inventory for proposed login-method retirement. */
export default class RetirementImpact extends BaseCommand {
  static commandName = 'account-kit:retirement-impact'
  static description = 'Count accounts affected by retiring login methods'
  static options = { startApp: true }

  @flags.boolean({ description: 'Return the structured result without printing it' })
  declare quiet: boolean

  @flags.boolean({ description: 'Password login remains enabled after this change' })
  declare keepPasswordLogin: boolean

  @flags.string({ description: 'Comma-separated provider names remaining after this change' })
  declare providers: string

  impact: Awaited<ReturnType<AccountKit['authentication']['retirementImpact']>> | null = null
  failure: 'inventory_unavailable' | null = null

  async run(): Promise<void> {
    try {
      const kit = await this.app.container.make(AccountKit)
      this.impact = await kit.authentication.retirementImpact({
        passwordLogin: this.keepPasswordLogin === true,
        providers: parseProviders(this.providers),
      })
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
