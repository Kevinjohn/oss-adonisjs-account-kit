import { E_ACCOUNT_KIT_INVALID_PROVIDERS_FLAG } from '../src/errors.ts'
import { BaseCommand, flags } from '@adonisjs/core/ace'
import { AccountKit } from '../src/account_kit.ts'
import { isSocialProviderName, socialProviderNames } from '../src/social_providers.ts'
import type { SocialProviderName } from '../src/types.ts'

/**
 * Parses `--providers`: absent keeps every configured provider; `none` or an empty list retires
 * them all. Throws an {@link E_ACCOUNT_KIT_INVALID_PROVIDERS_FLAG} for an unsupported or repeated name.
 */
function parseProviders(value?: string): SocialProviderName[] | undefined {
  if (value === undefined) return undefined
  if (value.trim() === 'none') return []
  const names = value
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean)
  const usage = `use a comma-separated list of ${socialProviderNames.join(', ')}, or none`
  for (const [index, name] of names.entries()) {
    if (!isSocialProviderName(name))
      throw new E_ACCOUNT_KIT_INVALID_PROVIDERS_FLAG(
        `Invalid --providers: the list contains an unsupported provider; ${usage}`
      )
    if (names.indexOf(name) !== index)
      throw new E_ACCOUNT_KIT_INVALID_PROVIDERS_FLAG(
        `Invalid --providers: ${name} is listed more than once; ${usage}`
      )
  }
  return names as SocialProviderName[]
}

/** Booted, read-only inventory for proposed login-method retirement. */
export default class RetirementImpact extends BaseCommand {
  static commandName = 'account-kit:retirement-impact'
  static description = 'Count accounts affected by retiring login methods'
  static options = { startApp: true }

  @flags.boolean({ description: 'Return the structured result without printing it' })
  declare quiet: boolean

  @flags.boolean({
    description: 'With --quiet, skip account enumeration when no current method is being retired',
  })
  declare onlyWhenRetiring: boolean

  @flags.boolean({ description: 'Password login remains enabled after this change' })
  declare keepPasswordLogin: boolean

  @flags.string({ description: 'Comma-separated provider names remaining after this change' })
  declare providers: string

  impact: Awaited<ReturnType<AccountKit['authentication']['retirementImpact']>> | null = null
  /** `invalid_providers` for a rejected `--providers` value; `inventory_unavailable` otherwise. */
  failure: 'inventory_unavailable' | 'invalid_providers' | null = null

  async run(): Promise<void> {
    const providers = parseProviders(this.providers)
    const kit = await this.app.container.make(AccountKit)
    this.impact = await kit.authentication.retirementImpact({
      passwordLogin: this.keepPasswordLogin === true,
      providers,
      ...(this.quiet && this.onlyWhenRetiring ? { onlyWhenRetiring: true } : {}),
    })
    if (!this.quiet) this.logger.log(JSON.stringify(this.impact))
  }

  completed(): boolean {
    if (this.exitCode === 0) return false
    const error: unknown = this.error
    this.failure =
      error instanceof E_ACCOUNT_KIT_INVALID_PROVIDERS_FLAG
        ? 'invalid_providers'
        : 'inventory_unavailable'
    if (!this.quiet)
      this.logger.error(
        error instanceof E_ACCOUNT_KIT_INVALID_PROVIDERS_FLAG
          ? error.message
          : 'Account inventory unavailable; verify Account Kit configuration and database access'
      )
    return true
  }
}
