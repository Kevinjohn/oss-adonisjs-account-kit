// Interactive setup questionnaire: turns prompt answers into SetupChoices.
import { defaultSetupChoices } from './defaults.js'
import { featureNames, type SetupChoices } from './types.js'
import { isSocialProviderName } from '../social_providers.js'
import type { SocialProviderName } from '../types.js'

function selected<const T extends string>(
  value: string,
  field: string,
  options: readonly T[]
): T[] {
  const names = value
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean)
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
  log: (message: string) => void
): Promise<SetupChoices> {
  const choices = defaultSetupChoices()
  const confirmed = async (question: string, fallback = false) => {
    const input = await ask(question)
    const answer = input.trim().toLowerCase()
    if (answer && !['yes', 'y', 'no', 'n'].includes(answer))
      throw new Error(`${question}: choose yes or no`)
    if (!answer) return fallback
    return answer === 'yes' || answer === 'y'
  }
  choices.mode = answerChoice(
    await ask('Consumption mode (managed/services)'),
    'mode',
    ['managed', 'services'],
    choices.mode
  )
  const enabledServices = await ask(
    `Enabled services, comma separated (${featureNames.join(', ')})`
  )
  choices.features = selected(
    enabledServices.trim() || choices.features.join(','),
    'features',
    featureNames
  )
  if (!choices.features.includes('registration')) choices.policy.registration = 'closed'
  if (!choices.features.includes('emailVerification')) choices.policy.verificationRequired = false
  const managedGroups =
    choices.mode === 'services' ? '' : await ask('Managed endpoint groups, comma separated')
  choices.managed =
    choices.mode === 'services'
      ? []
      : selected(managedGroups.trim() || choices.features.join(','), 'managed', featureNames)
  const excluded = await ask('Managed endpoint exclusions, comma separated (optional)')
  choices.managedExcept = excluded
    ? (excluded
        .split(',')
        .map((name) => name.trim())
        .filter(Boolean) as NonNullable<SetupChoices['managedExcept']>)
    : []
  choices.routePrefix = (await ask('Managed route prefix (/account)')) || choices.routePrefix
  choices.user.model = (await ask('User model import (#models/user)')) || choices.user.model
  choices.user.table = (await ask('User table (users)')) || choices.user.table
  choices.user.adapter = answerChoice(
    await ask('User adapter (lucid/custom)'),
    'user.adapter',
    ['lucid', 'custom'],
    choices.user.adapter
  )
  choices.user.idType = answerChoice(
    await ask('Physical id type (integer/string/uuid)'),
    'user.idType',
    ['integer', 'string', 'uuid'],
    choices.user.idType
  )
  if (choices.features.includes('authentication') || choices.managed.length) {
    choices.authentication!.strategy = answerChoice(
      await ask('Existing guard strategy (session/access_tokens)'),
      'authentication.strategy',
      ['session', 'access_tokens'],
      choices.authentication!.strategy
    )
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
  choices.mail.integration = answerChoice(
    await ask('Delivery integration (custom/adonisjs-mail)'),
    'mail.integration',
    ['custom', 'adonisjs-mail'],
    choices.mail.integration
  )
  choices.mail.delivery = answerChoice(
    await ask('Delivery guarantee (best-effort/durable)'),
    'mail.delivery',
    ['best-effort', 'durable'],
    choices.mail.delivery
  )
  choices.mail.durableWorkerVerified =
    choices.mail.delivery === 'durable' &&
    (await confirmed('Application queue worker, retries and terminal failures verified? (yes/no)'))
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
  const frontendOriginEnv = await ask('Trusted frontend origin environment name (FRONTEND_URL)')
  choices.mail.frontendOriginEnv = frontendOriginEnv.trim() || choices.mail.frontendOriginEnv
  if (choices.features.includes('invitations'))
    choices.mail.destinations.invitation = 'account/invitation'
  if (choices.features.includes('magicLinkLogin'))
    choices.mail.destinations.magicLink = 'account/magic-link'
  for (const [name, value] of Object.entries(choices.mail.destinations)) {
    choices.mail.destinations[name as keyof typeof choices.mail.destinations] =
      (await ask(`${name} relative frontend path (${value})`)) || value
  }
  choices.policy.registration = answerChoice(
    await ask('Registration policy (open/closed/application)'),
    'policy.registration',
    ['open', 'closed', 'application'],
    choices.policy.registration
  )
  const minLength = await ask('New-password minimum length (8)')
  if (minLength) choices.policy.password.minLength = Number(minLength)
  const maxLength = await ask('New-password maximum length (blank for no configured maximum)')
  choices.policy.password.maxLength = maxLength ? Number(maxLength) : null
  for (const key of ['letters', 'mixedCase', 'numbers', 'symbols'] as const)
    choices.policy.password[key] = await confirmed(`Require password ${key}? (yes/no)`)
  const minScore = await ask('Password strength score (0-4)')
  if (minScore) choices.policy.password.minScore = Number(minScore)
  choices.policy.verificationRequired = await confirmed(
    'Require verified email for account access? (yes/no)',
    choices.policy.verificationRequired
  )
  const unverifiedActions = await ask(
    'Allowed actions before verification (logout,verificationResend,passwordReset)'
  )
  choices.policy.unverifiedActions = selected(
    unverifiedActions.trim() || choices.policy.unverifiedActions.join(','),
    'policy.unverifiedActions',
    ['logout', 'verificationResend', 'passwordReset'] as const
  )
  const registrationFields = await ask('Additional registration fields as JSON array ([] for none)')
  if (registrationFields.trim()) choices.policy.registrationFields = JSON.parse(registrationFields)
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
    if (providers.some((name) => !isSocialProviderName(name)))
      throw new Error('social.providers: choose google and/or github')
    choices.social = {
      status: 'enabled',
      providers: [...new Set(providers)] as SocialProviderName[],
      callbackOriginEnv:
        (await ask('Social callback origin environment name (ACCOUNT_SOCIAL_ORIGIN)')) ||
        'ACCOUNT_SOCIAL_ORIGIN',
      callbackPath:
        (await ask('Social callback path with {provider} placeholder')) ||
        (choices.authentication?.strategy === 'access_tokens'
          ? '/auth/oauth/{provider}/callback'
          : `${choices.routePrefix}/auth/oauth/{provider}/callback`),
      credentials: {},
    }
    for (const provider of choices.social.providers) {
      choices.social.credentials[provider] = {
        clientIdEnv:
          (await ask(
            `${provider} client ID environment name (${provider.toUpperCase()}_CLIENT_ID)`
          )) || `${provider.toUpperCase()}_CLIENT_ID`,
        clientSecretEnv:
          (await ask(
            `${provider} client secret environment name (${provider.toUpperCase()}_CLIENT_SECRET)`
          )) || `${provider.toUpperCase()}_CLIENT_SECRET`,
      }
    }
    if (!choices.features.includes('socialAuthentication'))
      choices.features.push('socialAuthentication')
    if (choices.mode === 'managed' && !choices.managed.includes('socialAuthentication'))
      choices.managed.push('socialAuthentication')
    log('Selected providers require Ally console callbacks and deployment credentials')
  }
  return choices
}
