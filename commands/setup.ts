import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { BaseCommand, flags } from '@adonisjs/core/ace'
import { inspectSetup } from '../src/setup/inspect.js'
import { planSetup } from '../src/setup/plan.js'
import { applySetup } from '../src/setup/apply.js'
import { defaultSetupChoices } from '../src/setup/defaults.js'
import { featureNames, type SetupChoices, type SetupFeature } from '../src/setup/types.js'
import { parseSetupChoices } from '../src/setup/parse.js'
import type RetirementImpact from './retirement_impact.js'

function selected(value: string, field: string): SetupFeature[] {
  const names = value
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean)
  if (names.some((name) => !featureNames.includes(name as SetupFeature)))
    throw new Error(`${field}: choose from ${featureNames.join(', ')}`)
  return names as SetupFeature[]
}

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
    const choices = defaultSetupChoices()
    const ask = askOverride ?? ((question: string) => this.prompt.ask(question))
    const confirmed = async (question: string) => {
      const answer = await ask(question)
      return /^y(?:es)?$/i.test(answer.trim())
    }
    const mode = await ask('Consumption mode (managed/services)')
    if (mode === 'managed' || mode === 'services') choices.mode = mode
    choices.features = selected(
      (await ask(`Enabled services, comma separated (${featureNames.join(', ')})`)) ||
        choices.features.join(','),
      'features'
    )
    if (!choices.features.includes('registration')) choices.policy.registration = 'closed'
    if (!choices.features.includes('emailVerification')) choices.policy.verificationRequired = false
    choices.managed =
      choices.mode === 'services'
        ? []
        : selected(
            (await ask('Managed endpoint groups, comma separated')) || choices.features.join(','),
            'managed'
          )
    choices.routePrefix = (await ask('Managed route prefix (/account)')) || choices.routePrefix
    choices.user.model = (await ask('User model import (#models/user)')) || choices.user.model
    choices.user.table = (await ask('User table (users)')) || choices.user.table
    const adapter = await ask('User adapter (lucid/custom)')
    if (adapter === 'lucid' || adapter === 'custom') choices.user.adapter = adapter
    const idType = await ask('Physical id type (integer/string/uuid)')
    if (idType === 'integer' || idType === 'string' || idType === 'uuid')
      choices.user.idType = idType
    if (choices.features.includes('authentication') || choices.managed.length) {
      const strategy = await ask('Existing guard strategy (session/access_tokens)')
      if (strategy === 'session' || strategy === 'access_tokens')
        choices.authentication!.strategy = strategy
      choices.authentication!.guard = (await ask('Existing guard name (web)')) || 'web'
      if (choices.authentication!.strategy === 'session') {
        const session = choices.authentication!.session!
        session.secureCookie = await confirmed('Secure session cookie configured? (yes/no)')
        session.csrf = await confirmed('Shield CSRF protection configured? (yes/no)')
        session.originChecked = await confirmed(
          'Trusted origin and proxy configuration verified? (yes/no)'
        )
        session.persistentStore = await confirmed('Persistent session storage verified? (yes/no)')
      } else {
        delete choices.authentication!.session
        choices.authentication!.token = {
          revocation: await confirmed('Token revocation configured? (yes/no)'),
          lifetime: (await ask('Token lifetime (7d)')) || '7d',
          abilities: ((await ask('Token abilities, comma separated (*)')) || '*')
            .split(',')
            .map((value) => value.trim())
            .filter(Boolean),
        }
      }
      choices.authentication!.applicationRouteRevocation = await confirmed(
        'Application-owned protected routes use account revision checks? (yes/no)'
      )
    } else choices.authentication = null
    const mail = await ask('Delivery integration (custom/adonisjs-mail)')
    if (mail === 'custom' || mail === 'adonisjs-mail') choices.mail.integration = mail
    const delivery = await ask('Delivery guarantee (best-effort/durable)')
    if (delivery === 'best-effort' || delivery === 'durable') choices.mail.delivery = delivery
    choices.mail.durableWorkerVerified =
      choices.mail.delivery === 'durable' &&
      (await confirmed(
        'Application queue worker, retries and terminal failures verified? (yes/no)'
      ))
    if (choices.mail.integration === 'adonisjs-mail') {
      choices.mail.senderEnv =
        (await ask('Mail sender environment name (ACCOUNT_MAIL_FROM)')) || 'ACCOUNT_MAIL_FROM'
      choices.mail.transportEnv =
        (await ask('Mail transport environment name (MAIL_MAILER)')) || 'MAIL_MAILER'
    } else {
      choices.mail.senderEnv = null
      choices.mail.transportEnv = null
    }
    choices.mail.appName = (await ask('Application name')) || choices.mail.appName
    choices.mail.backendOriginEnv =
      (await ask('Trusted backend origin environment name (APP_URL)')) || 'APP_URL'
    choices.mail.frontendOriginEnv =
      (await ask('Trusted frontend origin environment name (ACCOUNT_FRONTEND_URL)')) ||
      'ACCOUNT_FRONTEND_URL'
    if (choices.features.includes('invitations'))
      choices.mail.destinations.invitation = 'account/invitation'
    for (const [name, value] of Object.entries(choices.mail.destinations)) {
      choices.mail.destinations[name as keyof typeof choices.mail.destinations] =
        (await ask(`${name} relative frontend path (${value})`)) || value
    }
    const registration = await ask('Registration policy (open/closed/application)')
    if (registration === 'open' || registration === 'closed' || registration === 'application')
      choices.policy.registration = registration
    const minLength = await ask('New-password minimum length (8)')
    if (minLength) choices.policy.password.minLength = Number(minLength)
    const maxLength = await ask('New-password maximum length (blank for no configured maximum)')
    choices.policy.password.maxLength = maxLength ? Number(maxLength) : null
    for (const key of ['letters', 'mixedCase', 'numbers', 'symbols'] as const)
      choices.policy.password[key] = await confirmed(`Require password ${key}? (yes/no)`)
    const minScore = await ask('Password strength score (0-4)')
    if (minScore) choices.policy.password.minScore = Number(minScore)
    choices.policy.verificationRequired = await confirmed(
      'Require verified email for account access? (yes/no)'
    )
    choices.policy.unverifiedActions = (
      (await ask(
        'Allowed actions before verification (logout,verificationResend,passwordReset)'
      )) || choices.policy.unverifiedActions.join(',')
    )
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean) as SetupChoices['policy']['unverifiedActions']
    const registrationFields = await ask(
      'Additional registration fields as JSON array ([] for none)'
    )
    if (registrationFields.trim())
      choices.policy.registrationFields = JSON.parse(registrationFields)
    if (choices.authentication)
      choices.policy.accessRestrictionHook = await confirmed(
        'Application restricted-account policy callback provided? (yes/no)'
      )
    if (choices.features.includes('invitations'))
      choices.policy.invitationPermissionHook = await confirmed(
        'Application invitation permission callbacks provided? (yes/no)'
      )
    const socialInput = await ask(
      'Social providers to prepare, comma separated (google,github; blank for none)'
    )
    const social = socialInput.trim()
    if (social) {
      const providers = social.split(',').map((name) => name.trim())
      if (providers.some((name) => name !== 'google' && name !== 'github'))
        throw new Error('social.providers: choose google and/or github')
      choices.social = {
        status: 'approved-pending',
        providers: [...new Set(providers)] as Array<'google' | 'github'>,
      }
      this.logger.info('Social identity is approved but pending installed implementation')
    }
    return choices
  }

  async run(): Promise<void> {
    const root = this.app.makePath('')
    const state = await inspectSetup(root)
    let choices: SetupChoices
    if (this.check) {
      if (!state.existingChoices)
        throw new Error('No config/account_kit_setup.json exists; run setup first')
      choices = state.existingChoices
    } else if (this.input) {
      const content = await readFile(resolve(root, this.input), 'utf8')
      choices = parseSetupChoices(JSON.parse(content))
    } else choices = await this.interactiveChoices()
    let retirementImpact: RetirementImpact['impact'] | null = null
    if (state.existingChoices?.authentication && !choices.authentication) {
      try {
        const inventory = await this.kernel.exec<typeof RetirementImpact>(
          'account-kit:retirement-impact',
          ['--quiet']
        )
        retirementImpact = inventory.impact
        if (inventory.failure)
          this.logger.warning(
            'Read-only account inventory could not query the application database'
          )
      } catch {
        this.logger.warning(
          'Read-only account inventory could not start; login retirement remains blocked'
        )
      }
    }
    const plan = await planSetup(choices, state, {
      apply: this.apply && !this.check,
      production: this.production,
      retirementImpact,
      retirementMaintenanceWindow: this.retirementMaintenanceWindow,
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
      this.logger.info(`Created ${written.length} files. Run migrations separately after review.`)
    }
  }
}
