import { DateTime } from 'luxon'
import { CapabilityDisabledError } from './errors.js'
import { budget } from './config_budget.js'
import { isSqlIdentifier } from './identifiers.js'
import { capabilities, capabilityRegistry, defaultCapabilities } from './capabilities.js'
import { resolveAuthentication } from './config_authentication.js'
import { resolvePasswordPolicy } from './config_password_policy.js'
import { isSocialProviderName } from './social_providers.js'
import { resolveSessionManagement } from './config_session_management.js'
import { expiresAt } from './ttl.js'
import type {
  AccountKitConfig,
  AuthorizationCallbacks,
  InvitationThrottle,
  NotificationCallbacks,
  ResolvedConfig,
  SocialProviderName,
  UrlCallbacks,
} from './types.js'

function disabled(): never {
  throw new CapabilityDisabledError('This account capability is disabled')
}

const disabledAuthorize: Record<keyof AuthorizationCallbacks, typeof disabled> = {
  invite: disabled,
  manageInvitation: disabled,
  listInvitations: disabled,
}
const disabledUrls: Record<keyof UrlCallbacks, typeof disabled> = {
  passwordReset: disabled,
  emailVerification: disabled,
  invitation: disabled,
  emailChange: disabled,
}
const disabledNotify: Record<keyof NotificationCallbacks, typeof disabled> = {
  passwordResetProvision: disabled,
  passwordResetCompleted: disabled,
  accountActivationProvision: disabled,
  invitationProvision: disabled,
  emailChangeProvision: disabled,
  emailChanged: disabled,
  passwordChanged: disabled,
  socialIdentityLinked: disabled,
  socialIdentityUnlinked: disabled,
}

export function defineConfig(config: AccountKitConfig): ResolvedConfig {
  if (!config || typeof config !== 'object' || !config.users || typeof config.users !== 'object')
    throw new Error('account_kit: users adapter must be configured')
  if (
    config.delivery !== undefined &&
    !['best-effort', 'durable', 'capture'].includes(config.delivery)
  )
    throw new Error('account_kit: delivery must be best-effort, durable, or capture')
  const enabled = config.enabled ?? defaultCapabilities
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
    for (const method of capabilityRegistry[capability].adapterMethods) {
      if (typeof config.users[method] !== 'function')
        throw new Error(`account_kit: users.${method} must be a function`)
    }
    for (const path of capabilityRegistry[capability].requiredHooks) {
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
    if (names.length === 0 || names.some((name) => !isSocialProviderName(name)))
      throw new Error('account_kit: socialAuthentication supports google and github only')
    for (const name of names) {
      const provider = social.providers[name as SocialProviderName]
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
  const passwordPolicy = resolvePasswordPolicy(config)
  const authentication = resolveAuthentication(config)
  if (enabled.includes('sessionManagement') && !authentication)
    throw new Error('account_kit: sessionManagement requires authentication')
  const sessionManagement = resolveSessionManagement(config)
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
  if (!isSqlIdentifier(usersTable))
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
    sessionManagement,
    usersTable,
    limiterNamespace,
    authorize: {
      ...disabledAuthorize,
      ...config.authorize,
    } as AuthorizationCallbacks,
    urls: {
      ...disabledUrls,
      ...config.urls,
    } as UrlCallbacks,
    notify: {
      ...disabledNotify,
      ...config.notify,
    } as NotificationCallbacks,
    onInvitationAccepted: config.onInvitationAccepted ?? disabled,
  }
}
