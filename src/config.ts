import { DateTime } from 'luxon'
import string from '@adonisjs/core/helpers/string'
import { CapabilityDisabledError } from './errors.js'
import { expiresAt } from './ttl.js'
import type {
  AccountKitConfig,
  AuthorizationCallbacks,
  Capability,
  InvitationThrottle,
  NotificationCallbacks,
  ResolvedAuthenticationConfig,
  ResolvedConfig,
  ThrottleBudget,
  UrlCallbacks,
} from './types.js'

const capabilities: Capability[] = [
  'passwordReset',
  'emailVerification',
  'invitations',
  'emailPasswordManagement',
  'registration',
  'socialAuthentication',
]
const adapterMethods: Record<Capability, string[]> = {
  passwordReset: [
    'findByEmail',
    'findById',
    'setPassword',
    'setUnverifiedEmail',
    'markEmailVerified',
  ],
  emailVerification: ['findById', 'markEmailVerified', 'setPassword'],
  invitations: ['findByEmail', 'findById', 'create', 'markEmailVerified'],
  emailPasswordManagement: [
    'findByEmail',
    'findById',
    'setPassword',
    'setEmail',
    'setUnverifiedEmail',
    'markEmailVerified',
    'verifyPassword',
  ],
  registration: ['findByEmail', 'findById', 'create'],
  socialAuthentication: ['findByEmail', 'findById', 'create', 'verifyPassword'],
}
const requiredHooks: Record<Capability, string[]> = {
  passwordReset: [
    'urls.passwordReset',
    'notify.passwordResetProvision',
    'notify.passwordResetCompleted',
  ],
  emailVerification: ['urls.emailVerification', 'notify.accountActivationProvision'],
  invitations: [
    'authorize.invite',
    'authorize.manageInvitation',
    'authorize.listInvitations',
    'urls.invitation',
    'notify.invitationProvision',
    'onInvitationAccepted',
  ],
  emailPasswordManagement: [
    'urls.emailChange',
    'urls.emailVerification',
    'notify.emailChangeProvision',
    'notify.accountActivationProvision',
    'notify.emailChanged',
    'notify.passwordChanged',
  ],
  registration: ['urls.emailVerification', 'notify.accountActivationProvision'],
  socialAuthentication: ['notify.socialIdentityLinked', 'notify.socialIdentityUnlinked'],
}

function budget(
  input: Partial<ThrottleBudget> | undefined,
  defaults: ThrottleBudget,
  name: string
): ThrottleBudget {
  if (input !== undefined && (!input || typeof input !== 'object' || Array.isArray(input)))
    throw new Error(`account_kit: ${name} must be a budget object`)
  const requests = input?.requests ?? defaults.requests
  const duration = input?.duration ?? defaults.duration
  if (!Number.isSafeInteger(requests) || requests <= 0)
    throw new Error(`account_kit: ${name}.requests must be a positive safe integer`)
  let milliseconds: number
  try {
    milliseconds = string.seconds.parse(duration) * 1000
  } catch (cause) {
    throw new Error(`account_kit: ${name}.duration must be a supported positive duration`, {
      cause,
    })
  }
  if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0 || milliseconds > 2_147_483_647)
    throw new Error(`account_kit: ${name}.duration must be a limiter-representable duration`)
  return { requests, duration }
}

function disabled(): never {
  throw new CapabilityDisabledError('This account capability is disabled')
}

export function defineConfig(config: AccountKitConfig): ResolvedConfig {
  if (!config || typeof config !== 'object' || !config.users || typeof config.users !== 'object')
    throw new Error('account_kit: users adapter must be configured')
  if (
    config.delivery !== undefined &&
    !['best-effort', 'durable', 'capture'].includes(config.delivery)
  )
    throw new Error('account_kit: delivery must be best-effort, durable, or capture')
  const enabled =
    config.enabled ??
    capabilities.filter(
      (name) => !['registration', 'invitations', 'socialAuthentication'].includes(name)
    )
  if (
    !Array.isArray(enabled) ||
    new Set(enabled).size !== enabled.length ||
    enabled.some((name) => !capabilities.includes(name))
  )
    throw new Error('account_kit: enabled must contain unique supported capability names')
  if (enabled.includes('emailPasswordManagement') && !enabled.includes('emailVerification'))
    throw new Error('account_kit: emailPasswordManagement requires emailVerification')
  for (const name of ['authorize', 'urls', 'notify', 'expiresIn', 'invitationThrottle'] as const) {
    const value = config[name]
    if (value !== undefined && (!value || typeof value !== 'object' || Array.isArray(value)))
      throw new Error(`account_kit: ${name} must be an object`)
  }
  for (const capability of enabled) {
    for (const method of adapterMethods[capability]) {
      if (typeof config.users[method as keyof typeof config.users] !== 'function')
        throw new Error(`account_kit: users.${method} must be a function`)
    }
    for (const path of requiredHooks[capability]) {
      const parts = path.split('.')
      const parent =
        parts.length === 1 ? config : config[parts[0] as 'urls' | 'notify' | 'authorize']
      if (typeof (parent as Record<string, unknown> | undefined)?.[parts.at(-1)!] !== 'function')
        throw new Error(`account_kit: ${path} must be a function`)
    }
  }
  if (
    !config.registration ||
    !['open', 'closed', 'application'].includes(config.registration.availability)
  )
    throw new Error('account_kit: registration.availability must be open, closed, or application')
  if (
    config.registration.mapFields !== undefined &&
    typeof config.registration.mapFields !== 'function'
  )
    throw new Error('account_kit: registration.mapFields must be a function')
  if (enabled.includes('socialAuthentication')) {
    if (!enabled.includes('emailVerification'))
      throw new Error(
        'account_kit: socialAuthentication requires emailVerification for unverified provider email'
      )
    const social = config.socialAuthentication
    if (!social || !social.providers || !config.registration || !config.authentication)
      throw new Error(
        'account_kit: socialAuthentication requires providers, registration and authentication'
      )
    const names = Object.keys(social.providers)
    if (names.length === 0 || names.some((name) => name !== 'google' && name !== 'github'))
      throw new Error('account_kit: socialAuthentication supports google and github only')
    for (const name of names) {
      const provider = social.providers[name as 'google' | 'github']
      if (
        typeof provider?.authorizationUrl !== 'function' ||
        typeof provider.resolve !== 'function'
      )
        throw new Error(`account_kit: socialAuthentication.providers.${name} must use Ally`)
      if (
        provider.verifyFreshAuthentication !== undefined &&
        typeof provider.verifyFreshAuthentication !== 'function'
      )
        throw new Error(
          `account_kit: socialAuthentication.providers.${name}.verifyFreshAuthentication must be a function`
        )
    }
  }
  for (const hook of [
    'onInvitationAccepted',
    'onCredentialsChanged',
    'onCredentialsChangedTransaction',
    'onPasswordResetIssuedTransaction',
    'onLifecycleEvent',
  ] as const) {
    if (config[hook] !== undefined && typeof config[hook] !== 'function')
      throw new Error(`account_kit: ${hook} must be a function when supplied`)
  }
  if (config.onCredentialsChanged && config.onCredentialsChangedTransaction)
    throw new Error('account_kit: credential revocation hooks are mutually exclusive')
  if (typeof config.limiterSecret !== 'string' || Buffer.byteLength(config.limiterSecret) < 32)
    throw new Error(
      'account_kit: limiterSecret must be a stable shared secret of at least 32 bytes'
    )
  const limiterNamespace = config.limiterNamespace ?? 'default'
  if (
    typeof limiterNamespace !== 'string' ||
    limiterNamespace.length === 0 ||
    limiterNamespace.length > 128
  )
    throw new Error(
      'account_kit: limiterNamespace must be a non-empty string of at most 128 characters'
    )
  const expiresIn = {
    passwordReset: config.expiresIn?.passwordReset ?? '1h',
    emailVerification: config.expiresIn?.emailVerification ?? '1h',
    invitation: config.expiresIn?.invitation ?? '7d',
    emailChange: config.expiresIn?.emailChange ?? '1h',
  }
  for (const value of Object.values(expiresIn)) expiresAt(DateTime.utc(), value)
  const throttle = budget(config.throttle, { requests: 5, duration: '15m' }, 'throttle')
  const invitationThrottle = Object.fromEntries(
    ['sendActor', 'sendRecipient', 'resendActor', 'resendInvitation'].map((name) => [
      name,
      budget(
        config.invitationThrottle?.[name as keyof InvitationThrottle],
        { requests: name.endsWith('Actor') ? 10 : 3, duration: '1h' },
        `invitationThrottle.${name}`
      ),
    ])
  ) as unknown as InvitationThrottle
  const minRequestMs = config.minRequestMs ?? 300
  if (!Number.isFinite(minRequestMs) || minRequestMs < 0)
    throw new Error('account_kit: minRequestMs must be a finite non-negative number')
  const tokenSecretLength = config.tokenSecretLength ?? 40
  if (!Number.isSafeInteger(tokenSecretLength) || tokenSecretLength < 16 || tokenSecretLength > 64)
    throw new Error('account_kit: tokenSecretLength must be an integer from 16 to 64')
  const passwordPolicy = {
    minLength: config.passwordPolicy?.minLength ?? 8,
    maxLength: config.passwordPolicy?.maxLength ?? null,
    letters: config.passwordPolicy?.letters ?? false,
    mixedCase: config.passwordPolicy?.mixedCase ?? false,
    numbers: config.passwordPolicy?.numbers ?? false,
    symbols: config.passwordPolicy?.symbols ?? false,
    minScore: config.passwordPolicy?.minScore ?? 0,
  }
  if (
    config.passwordPolicy !== undefined &&
    (!config.passwordPolicy ||
      typeof config.passwordPolicy !== 'object' ||
      Array.isArray(config.passwordPolicy))
  )
    throw new Error('account_kit: passwordPolicy must be an object')
  if (
    !Number.isSafeInteger(passwordPolicy.minLength) ||
    passwordPolicy.minLength < 8 ||
    passwordPolicy.minLength > 256 ||
    (passwordPolicy.maxLength !== null &&
      (!Number.isSafeInteger(passwordPolicy.maxLength) ||
        passwordPolicy.maxLength > 256 ||
        passwordPolicy.maxLength < passwordPolicy.minLength))
  )
    throw new Error(
      'account_kit: passwordPolicy lengths must stay within 8–256 and minLength must not exceed maxLength'
    )
  if (
    !Number.isSafeInteger(passwordPolicy.minScore) ||
    passwordPolicy.minScore < 0 ||
    passwordPolicy.minScore > 4
  )
    throw new Error('account_kit: passwordPolicy.minScore must be an integer from 0 to 4')
  for (const key of ['letters', 'mixedCase', 'numbers', 'symbols'] as const)
    if (typeof passwordPolicy[key] !== 'boolean')
      throw new Error(`account_kit: passwordPolicy.${key} must be boolean`)
  let authentication: ResolvedAuthenticationConfig | undefined
  if (config.authentication !== undefined) {
    const auth = config.authentication
    if (!auth || typeof auth !== 'object' || Array.isArray(auth))
      throw new Error('account_kit: authentication must be an object')
    if (auth.strategy !== 'session' && auth.strategy !== 'access_tokens')
      throw new Error('account_kit: authentication.strategy must be session or access_tokens')
    if (typeof auth.guard !== 'string' || auth.guard.trim() === '')
      throw new Error('account_kit: authentication.guard must name an existing guard')
    if (auth.canAccess !== undefined && typeof auth.canAccess !== 'function')
      throw new Error('account_kit: authentication.canAccess must be a function')
    if (
      auth.tokenAbilities !== undefined &&
      (!Array.isArray(auth.tokenAbilities) ||
        auth.tokenAbilities.length === 0 ||
        auth.tokenAbilities.some((ability) => typeof ability !== 'string' || ability.trim() === ''))
    )
      throw new Error('account_kit: authentication.tokenAbilities must be non-empty strings')
    if (auth.tokenExpiresIn !== undefined) expiresAt(DateTime.utc(), auth.tokenExpiresIn)
    const tokenTable = auth.tokenTable ?? 'auth_access_tokens'
    if (typeof tokenTable !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(tokenTable))
      throw new Error('account_kit: authentication.tokenTable must be a plain SQL identifier')
    const clientLimit = budget(
      auth.clientLimit,
      { requests: 10, duration: '1m' },
      'authentication.clientLimit'
    )
    const identityLimit = budget(
      auth.identityLimit,
      { requests: 5, duration: '1m' },
      'authentication.identityLimit'
    )
    const blockDuration = auth.identityLimit?.blockDuration ?? '20m'
    budget(
      { requests: 1, duration: blockDuration },
      { requests: 1, duration: '20m' },
      'authentication.identityLimit.blockDuration'
    )
    authentication = {
      strategy: auth.strategy,
      guard: auth.guard,
      canAccess: auth.canAccess ?? (async () => true),
      clientLimit,
      identityLimit: { ...identityLimit, blockDuration },
      tokenAbilities: [...(auth.tokenAbilities ?? ['*'])],
      tokenExpiresIn: auth.tokenExpiresIn ?? null,
      tokenTable,
    }
  }
  if (
    config.users.resolveMetadata !== undefined &&
    typeof config.users.resolveMetadata !== 'function'
  )
    throw new Error('account_kit: users.resolveMetadata must be a function')
  if (config.users.resolveMetadata && config.usersTable !== undefined)
    throw new Error(
      'account_kit: usersTable is for custom adapters; the Lucid adapter derives its table'
    )
  if (
    config.emailConstraint !== undefined &&
    (typeof config.emailConstraint !== 'string' || config.emailConstraint.trim() === '')
  )
    throw new Error('account_kit: emailConstraint must be a non-empty constraint name')
  const usersTable = config.usersTable ?? 'users'
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(usersTable))
    throw new Error('account_kit: usersTable must be a plain SQL identifier')
  return {
    ...config,
    enabled: [...enabled],
    delivery: config.delivery ?? 'best-effort',
    expiresIn,
    throttle,
    invitationThrottle,
    minRequestMs,
    tokenSecretLength,
    authentication,
    passwordPolicy,
    usersTable,
    limiterNamespace,
    authorize: {
      invite: disabled,
      manageInvitation: disabled,
      listInvitations: disabled,
      ...config.authorize,
    } as AuthorizationCallbacks,
    urls: {
      passwordReset: disabled,
      emailVerification: disabled,
      invitation: disabled,
      emailChange: disabled,
      ...config.urls,
    } as UrlCallbacks,
    notify: {
      passwordResetProvision: disabled,
      passwordResetCompleted: disabled,
      accountActivationProvision: disabled,
      invitationProvision: disabled,
      emailChangeProvision: disabled,
      emailChanged: disabled,
      passwordChanged: disabled,
      socialIdentityLinked: disabled,
      socialIdentityUnlinked: disabled,
      ...config.notify,
    } as NotificationCallbacks,
    onInvitationAccepted: config.onInvitationAccepted ?? disabled,
  }
}
