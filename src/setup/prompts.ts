// Interactive setup questionnaire: turns prompt answers into SetupChoices.
import { defaultSetupChoices } from './defaults.js'
import {
  featureNames,
  guardStrategies,
  mailDeliveries,
  mailIntegrations,
  registrationPolicies,
  setupModes,
  unverifiedActionNames,
  userAdapters,
  userIdTypes,
  type SetupChoices,
} from './types.js'
import { collectSocialChoices } from './prompts_social.js'
import { emailDestinations, hasEmailFlow } from './mail_flow.js'
import { selectedManagedRoutes } from './shared.js'
import { parseSetupChoices } from './parse.js'

function list(value: string): string[] {
  return value
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean)
}

function selected<const T extends string>(
  value: string,
  field: string,
  options: readonly T[]
): T[] {
  const names = list(value)
  if (names.some((name) => !options.includes(name as T)))
    throw new Error(`${field}: choose from ${options.join(', ')}`)
  return names as T[]
}

function answerChoice<const T extends string>(
  value: string,
  field: string,
  options: readonly T[],
  fallback: T
): T {
  const answer = value.trim()
  if (!answer) return fallback
  if (!options.includes(answer as T)) throw new Error(`${field}: choose from ${options.join(', ')}`)
  return answer as T
}

export async function collectSetupChoices(
  ask: (question: string) => Promise<string>,
  log: (message: string) => void,
  initialChoices?: SetupChoices
): Promise<SetupChoices> {
  const hasSavedChoices = initialChoices !== undefined
  const choices = parseSetupChoices(structuredClone(initialChoices ?? defaultSetupChoices()))
  const savedRoutePrefix = choices.routePrefix
  const savedStrategy = choices.authentication?.strategy
  const confirmed = async (question: string, fallback = false) => {
    const input = await ask(question)
    const answer = input.trim().toLowerCase()
    if (answer && !['yes', 'y', 'no', 'n'].includes(answer))
      throw new Error(`${question}: choose yes or no`)
    if (!answer) return fallback
    return answer === 'yes' || answer === 'y'
  }
  choices.mode = answerChoice(
    await ask(`Consumption mode (managed/services; current: ${choices.mode})`),
    'mode',
    setupModes,
    choices.mode
  )
  const enabledServices = await ask(
    `Enabled services, comma separated (${featureNames.join(', ')}; current: ${choices.features.join(', ')})`
  )
  choices.features = selected(
    enabledServices.trim() || choices.features.join(','),
    'features',
    featureNames
  )
  const registrationEnabled = choices.features.includes('registration')
  const registrationFieldsApplicable = [
    'registration',
    'invitations',
    'emailPasswordManagement',
    'socialAuthentication',
  ].some((feature) => choices.features.includes(feature as (typeof featureNames)[number]))
  // Social sign-in creates accounts under `closed` or `application` too; only `open` needs
  // ordinary registration.
  if (!registrationEnabled && choices.policy.registration === 'open') {
    choices.policy.registration = 'closed'
  }
  if (!registrationFieldsApplicable) choices.policy.registrationFields = []
  const verificationEnabled = choices.features.includes('emailVerification')
  if (!verificationEnabled) {
    choices.policy.verificationRequired = false
    choices.policy.unverifiedActions = []
  }
  const managedGroups =
    choices.mode === 'services'
      ? ''
      : await ask(
          `Managed endpoint groups, comma separated (current: ${choices.managed.join(', ') || 'none'})`
        )
  choices.managed =
    choices.mode === 'services'
      ? []
      : selected(
          managedGroups.trim() ||
            (hasSavedChoices
              ? choices.managed.filter((feature) => choices.features.includes(feature))
              : choices.features
            ).join(','),
          'managed',
          featureNames
        )
  const excluded = await ask(
    `Managed endpoint exclusions, comma separated (current: ${choices.managedExcept?.join(', ') || 'none'})`
  )
  const exclusionsProvided = Boolean(excluded.trim())
  if (exclusionsProvided) {
    choices.managedExcept = list(excluded) as NonNullable<SetupChoices['managedExcept']>
  } else if (!choices.managed.length || !choices.authentication) {
    choices.managedExcept = []
  }
  choices.routePrefix =
    (await ask(`Managed route prefix (${choices.routePrefix})`)) || choices.routePrefix
  choices.user.model =
    (await ask(`User model import (${choices.user.model})`)) || choices.user.model
  choices.user.table = (await ask(`User table (${choices.user.table})`)) || choices.user.table
  choices.user.adapter = answerChoice(
    await ask(`User adapter (lucid/custom; current: ${choices.user.adapter})`),
    'user.adapter',
    userAdapters,
    choices.user.adapter
  )
  choices.user.idType = answerChoice(
    await ask(`Physical id type (integer/string/uuid; current: ${choices.user.idType})`),
    'user.idType',
    userIdTypes,
    choices.user.idType
  )
  if (choices.features.includes('authentication') || choices.managed.length) {
    const defaults = defaultSetupChoices().authentication!
    choices.authentication ??= structuredClone(defaults)
    choices.authentication.strategy = answerChoice(
      await ask(
        `Existing guard strategy (session/access_tokens; current: ${choices.authentication.strategy})`
      ),
      'authentication.strategy',
      guardStrategies,
      choices.authentication.strategy
    )
    choices.authentication.guard =
      (await ask(`Existing guard name (${choices.authentication.guard})`)) ||
      choices.authentication.guard
    if (choices.authentication.strategy === 'session') {
      const session =
        choices.authentication.session ??
        structuredClone(
          defaults.session ?? {
            secureCookie: false,
            csrf: false,
            originChecked: false,
            persistentStore: false,
          }
        )
      choices.authentication.session = session
      delete choices.authentication.token
      session.secureCookie = await confirmed(
        `Secure session cookie configured? (yes/no; current: ${session.secureCookie ? 'yes' : 'no'})`,
        session.secureCookie
      )
      session.csrf = await confirmed(
        `Shield CSRF protection configured? (yes/no; current: ${session.csrf ? 'yes' : 'no'})`,
        session.csrf
      )
      session.originChecked = await confirmed(
        `Trusted origin and proxy configuration verified? (yes/no; current: ${session.originChecked ? 'yes' : 'no'})`,
        session.originChecked
      )
      session.persistentStore = await confirmed(
        `Persistent session storage verified? (yes/no; current: ${session.persistentStore ? 'yes' : 'no'})`,
        session.persistentStore
      )
    } else {
      delete choices.authentication.session
      const token = choices.authentication.token ?? {
        revocation: false,
        lifetime: '7d',
        abilities: ['*'],
      }
      choices.authentication.token = {
        revocation: await confirmed(
          `Token revocation configured? (yes/no; current: ${token.revocation ? 'yes' : 'no'})`,
          token.revocation
        ),
        lifetime: (await ask(`Token lifetime (${token.lifetime})`)) || token.lifetime,
        abilities: list(
          (await ask(`Token abilities, comma separated (${token.abilities.join(', ')})`)) ||
            token.abilities.join(',')
        ),
      }
    }
    choices.authentication.applicationRouteRevocation = await confirmed(
      `Application-owned protected routes use account revision checks? (yes/no; current: ${choices.authentication.applicationRouteRevocation ? 'yes' : 'no'})`,
      choices.authentication.applicationRouteRevocation
    )
  } else {
    choices.authentication = null
    choices.policy.accessRestrictionHook = false
  }
  if (!choices.features.includes('invitations')) choices.policy.invitationPermissionHook = false
  if (hasEmailFlow(choices)) {
    choices.mail.integration = answerChoice(
      await ask(
        `Delivery integration (custom/adonisjs-mail; current: ${choices.mail.integration})`
      ),
      'mail.integration',
      mailIntegrations,
      choices.mail.integration
    )
    choices.mail.delivery = answerChoice(
      await ask(`Delivery guarantee (best-effort/durable; current: ${choices.mail.delivery})`),
      'mail.delivery',
      mailDeliveries,
      choices.mail.delivery
    )
    choices.mail.durableWorkerVerified =
      choices.mail.delivery === 'durable' &&
      (await confirmed(
        `Application queue worker, retries and terminal failures verified? (yes/no; current: ${choices.mail.durableWorkerVerified ? 'yes' : 'no'})`,
        choices.mail.durableWorkerVerified
      ))
    if (choices.mail.integration === 'adonisjs-mail') {
      choices.mail.senderEnv =
        (await ask(
          `Mail sender environment name (${choices.mail.senderEnv ?? 'ACCOUNT_MAIL_FROM'})`
        )) ||
        choices.mail.senderEnv ||
        'ACCOUNT_MAIL_FROM'
      choices.mail.transportEnv =
        (await ask(
          `Mail transport environment name (${choices.mail.transportEnv ?? 'MAIL_MAILER'})`
        )) ||
        choices.mail.transportEnv ||
        'MAIL_MAILER'
    } else {
      choices.mail.senderEnv = null
      choices.mail.transportEnv = null
    }
    choices.mail.appName =
      (await ask(`Application name (${choices.mail.appName})`)) || choices.mail.appName
    choices.mail.backendOriginEnv =
      (await ask(`Trusted backend origin environment name (${choices.mail.backendOriginEnv})`)) ||
      choices.mail.backendOriginEnv
    const frontendOriginEnv = await ask(
      `Trusted frontend origin environment name (${choices.mail.frontendOriginEnv})`
    )
    choices.mail.frontendOriginEnv = frontendOriginEnv.trim() || choices.mail.frontendOriginEnv
    const requiredDestinations = new Set(
      choices.features
        .map((feature) => emailDestinations[feature])
        .filter((destination): destination is NonNullable<typeof destination> =>
          Boolean(destination)
        )
    )
    const defaultDestinations = {
      ...defaultSetupChoices().mail.destinations,
      invitation: 'account/invitation',
      magicLink: 'account/magic-link',
    }
    for (const name of requiredDestinations)
      choices.mail.destinations[name] ??= defaultDestinations[name]
    choices.mail.destinations = Object.fromEntries(
      Object.entries(choices.mail.destinations).filter(([name]) =>
        requiredDestinations.has(name as keyof typeof choices.mail.destinations)
      )
    ) as SetupChoices['mail']['destinations']
    for (const [name, value] of Object.entries(choices.mail.destinations)) {
      if (!requiredDestinations.has(name as keyof typeof choices.mail.destinations)) continue
      choices.mail.destinations[name as keyof typeof choices.mail.destinations] =
        (await ask(`${name} relative frontend path (${value})`)) || value
    }
  } else {
    choices.mail = defaultSetupChoices().mail
  }
  if (registrationEnabled || choices.features.includes('socialAuthentication')) {
    choices.policy.registration = answerChoice(
      await ask(
        `Registration policy (open/closed/application; current: ${choices.policy.registration})`
      ),
      'policy.registration',
      registrationPolicies,
      choices.policy.registration
    )
  }
  const minLength = await ask(`New-password minimum length (${choices.policy.password.minLength})`)
  if (minLength) choices.policy.password.minLength = Number(minLength)
  const maxLength = await ask(
    `New-password maximum length (${choices.policy.password.maxLength ?? 'none'}; blank to keep, none to remove)`
  )
  if (maxLength.trim().toLowerCase() === 'none') choices.policy.password.maxLength = null
  else if (maxLength.trim()) choices.policy.password.maxLength = Number(maxLength)
  for (const key of ['letters', 'mixedCase', 'numbers', 'symbols'] as const)
    choices.policy.password[key] = await confirmed(
      `Require password ${key}? (yes/no; current: ${choices.policy.password[key] ? 'yes' : 'no'})`,
      choices.policy.password[key]
    )
  const minScore = await ask(
    `Password strength score (0-4; current: ${choices.policy.password.minScore})`
  )
  if (minScore) choices.policy.password.minScore = Number(minScore)
  if (verificationEnabled) {
    choices.policy.verificationRequired = await confirmed(
      'Require verified email for account access? (yes/no)',
      choices.policy.verificationRequired
    )
    const unverifiedActions = await ask(
      `Allowed actions before verification (logout,verificationResend,passwordReset; current: ${choices.policy.unverifiedActions.join(', ')})`
    )
    choices.policy.unverifiedActions = selected(
      unverifiedActions.trim() || choices.policy.unverifiedActions.join(','),
      'policy.unverifiedActions',
      unverifiedActionNames
    )
  }
  if (registrationFieldsApplicable) {
    const registrationFields = await ask(
      `Additional profile fields for registration, invitations, email changes or social sign-in as JSON array (current: ${JSON.stringify(choices.policy.registrationFields)})`
    )
    if (registrationFields.trim())
      choices.policy.registrationFields = JSON.parse(registrationFields)
  } else {
    choices.policy.registrationFields = []
  }
  if (choices.authentication)
    choices.policy.accessRestrictionHook = await confirmed(
      `Application restricted-account policy callback provided? (yes/no; current: ${choices.policy.accessRestrictionHook ? 'yes' : 'no'})`,
      choices.policy.accessRestrictionHook
    )
  if (choices.features.includes('invitations'))
    choices.policy.invitationPermissionHook = await confirmed(
      `Application invitation permission callbacks provided? (yes/no; current: ${choices.policy.invitationPermissionHook ? 'yes' : 'no'})`,
      choices.policy.invitationPermissionHook
    )
  await collectSocialChoices(choices, ask, log, savedRoutePrefix, savedStrategy)
  if (
    !exclusionsProvided &&
    /^\/(?:[\w-]+(?:\/[\w-]+)*)?$/.test(choices.routePrefix) &&
    choices.routePrefix !== '/'
  ) {
    const availableRoutes = new Set(
      selectedManagedRoutes({ ...choices, managedExcept: [] }).map(({ name }) => name)
    )
    choices.managedExcept = (choices.managedExcept ?? []).filter((name) =>
      availableRoutes.has(name)
    )
  }
  return choices
}
