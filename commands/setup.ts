import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { BaseCommand, flags } from '@adonisjs/core/ace'
import { inspectSetup } from '../src/setup/inspect.js'
import { planSetup } from '../src/setup/plan.js'
import { applySetup } from '../src/setup/apply.js'
import type { SetupChoices, SetupInspection } from '../src/setup/types.js'
import { collectSetupChoices } from '../src/setup/prompts.js'
import { parseSetupChoices } from '../src/setup/parse.js'
import type RetirementImpact from './retirement_impact.js'

/** No prompt path is reachable from --input or --check. */
export default class SetupAccountKit extends BaseCommand {
  static commandName = 'account-kit:setup'
  static description = 'Inspect, preview and apply Account Kit onboarding choices'
  static options = { startApp: false }

  @flags.string({ description: 'Path to typed noninteractive JSON choices' })
  declare input?: string

  @flags.boolean({ description: 'Apply the complete conflict-free plan; preview is the default' })
  declare apply: boolean

  @flags.boolean({ description: 'Check persisted configuration without writing' })
  declare check: boolean

  @flags.boolean({ description: 'Check production origin and session prerequisites' })
  declare production: boolean

  @flags.boolean({
    description: 'Confirm login retirement runs inside a credential-change maintenance window',
  })
  declare retirementMaintenanceWindow: boolean

  async interactiveChoices(
    askOverride?: (question: string) => Promise<string>
  ): Promise<SetupChoices> {
    if (!process.stdin.isTTY && !askOverride)
      throw new Error('Missing --input: provide a JSON choices file for noninteractive setup')
    const ask = askOverride ?? ((question: string) => this.prompt.ask(question))
    return collectSetupChoices(ask, (message) => this.logger.info(message))
  }

  /** Choices from the saved file (--check), the --input file, or the prompts. */
  private async loadChoices(root: string, state: SetupInspection): Promise<SetupChoices> {
    if (this.check) {
      if (!state.existingChoices)
        throw new Error('No config/account_kit_setup.json exists; run setup first')
      return state.existingChoices
    }
    if (this.input) {
      const content = await readFile(resolve(root, this.input), 'utf8')
      return parseSetupChoices(JSON.parse(content))
    }
    return this.interactiveChoices()
  }

  /** Count accounts the choices would retire, through the booted read-only inventory command. */
  private async runtimeInventory(choices: SetupChoices): Promise<{
    retirementImpact: RetirementImpact['impact'] | null
    runtimeInventoryUnavailable: boolean
  }> {
    const remainingProviders = choices.social.status === 'enabled' ? choices.social.providers : []
    try {
      const inventory = await this.kernel.exec<typeof RetirementImpact>(
        'account-kit:retirement-impact',
        [
          '--quiet',
          ...(choices.authentication ? ['--keep-password-login'] : []),
          `--providers=${remainingProviders.length ? remainingProviders.join(',') : 'none'}`,
        ]
      )
      if (inventory.failure || !inventory.impact) {
        this.logger.warning('Read-only account inventory could not query the application database')
        return { retirementImpact: inventory.impact, runtimeInventoryUnavailable: true }
      }
      return { retirementImpact: inventory.impact, runtimeInventoryUnavailable: false }
    } catch {
      this.logger.warning(
        'Read-only account inventory could not start; login retirement remains blocked'
      )
      return { retirementImpact: null, runtimeInventoryUnavailable: true }
    }
  }

  async run(): Promise<void> {
    const root = this.app.makePath('')
    const state = await inspectSetup(root)
    const choices = await this.loadChoices(root, state)
    const { retirementImpact, runtimeInventoryUnavailable } = state.existingChoices
      ? await this.runtimeInventory(choices)
      : { retirementImpact: null, runtimeInventoryUnavailable: false }
    const plan = await planSetup(choices, state, {
      apply: this.apply && !this.check,
      production: this.production,
      retirementImpact,
      retirementMaintenanceWindow: this.retirementMaintenanceWindow,
      runtimeInventoryUnavailable,
    })
    this.logger.info(
      JSON.stringify(
        {
          preview: plan.preview,
          pillars: plan.pillars,
          changes: plan.changes.map(({ path, action, reason }) => ({ path, action, reason })),
          differences: plan.differences,
          retirementImpact: plan.retirementImpact,
          endpoints: plan.endpoints,
          endpointLocations: plan.endpointLocations,
          prerequisites: plan.prerequisites,
          diagnostics: plan.diagnostics,
          migrationState: plan.migrationState,
          readiness: plan.readiness,
        },
        null,
        2
      )
    )
    if (this.check) {
      if (!plan.readiness.configurationValid) this.exitCode = 1
      return
    }
    if (plan.diagnostics.some((item) => item.severity === 'error')) {
      this.exitCode = 1
      return
    }
    if (!plan.preview) {
      const written = await applySetup(root, plan)
      this.logger.info(`Wrote ${written.length} files. Run migrations separately after review.`)
    }
  }
}
