import { DateTime } from 'luxon'
import { CapabilityDisabledError, InvalidConfigurationError } from './errors.js'
import { budget } from './config_budget.js'
import { assertObject } from './config_assert.js'
import { isSqlIdentifier } from './sql_identifier.js'
import { capabilities, capabilityRegistry, defaultCapabilities } from './capabilities.js'
import { resolveAuthentication } from './config_authentication.js'
import { resolvePasswordPolicy } from './config_password_policy.js'
import { resolveAccountDeletion } from './config_account_deletion.js'
import { resolveSessionManagement } from './config_session_management.js'
import { validateSocialAuthentication } from './config_social_authentication.js'
import { configuredExpiresAt } from './config_ttl.js'
import type {
  AccountKitConfig,
  AuthorizationCallbacks,
  InvitationThrottle,
  NotificationCallbacks,
  ResolvedConfig,
  UrlCallbacks,
} from './types.js'
import { freezeResolved } from './config_freeze.js'

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
  magicLink: disabled,
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
  magicLinkProvision: disabled,
  accountDeleted: disabled,
}

/**
 * Binds each callback the application supplied to the object that holds it, so prototype methods
 * keep `this`. A missing callback keeps its disabled default.
 */
function bindCallbacks<T extends object>(container: object | undefined, defaults: T): T {
  const result: Record<string, unknown> = {}
  for (const key of Object.keys(defaults)) {
    const fn = (container as Record<string, unknown> | undefined)?.[key]
    result[key] = typeof fn === 'function' ? fn.bind(container) : defaults[key as keyof T]
  }
  return freezeResolved(result) as T
}

/** Binds the application's top-level hooks to the configuration object it passed. */
function bindTopLevelHooks<T extends AccountKitConfig>(config: T): T {
  return Object.fromEntries(
    Object.entries(config).map(([key, value]) => [
      key,
      typeof value === 'function' ? value.bind(config) : value,
    ])
  ) as T
}

/**
 * Validates the Account Kit config and fills in defaults. Throws at boot, with the field name, for
 * a missing callback an enabled capability needs or an out-of-range value.
 */
export function defineConfig(config: AccountKitConfig): ResolvedConfig {
  if (!config || typeof config !== 'object' || !config.users || typeof config.users !== 'object')
    throw new InvalidConfigurationError('users', 'account_kit: users adapter must be configured')
  if (
    config.delivery !== undefined &&
    !['best-effort', 'durable', 'capture'].includes(config.delivery)
  )
    throw new InvalidConfigurationError(
      'delivery',
      'account_kit: delivery must be best-effort, durable, or capture'
    )
  const enabled = config.enabled ?? defaultCapabilities
  if (
    !Array.isArray(enabled) ||
    new Set(enabled).size !== enabled.length ||
    enabled.some((name) => !capabilities.includes(name))
  )
    throw new InvalidConfigurationError(
      'enabled',
      'account_kit: enabled must contain unique supported capability names'
    )
  if (enabled.includes('emailPasswordManagement') && !enabled.includes('emailVerification'))
    throw new InvalidConfigurationError(
      'emailPasswordManagement',
      'account_kit: emailPasswordManagement requires emailVerification'
    )
  for (const name of ['authorize', 'urls', 'notify', 'expiresIn', 'invitationThrottle'] as const) {
    if (config[name] !== undefined) assertObject(config[name], name)
  }
  if (config.users.hashPassword !== undefined) {
    if (typeof config.users.hashPassword !== 'function')
      throw new InvalidConfigurationError(
        'users.hashPassword',
        'account_kit: users.hashPassword must be a function'
      )
    if (typeof config.users.setPasswordHash !== 'function')
      throw new InvalidConfigurationError(
        'users.setPasswordHash',
        'account_kit: users.setPasswordHash must be a function when users.hashPassword is set'
      )
  }
  for (const capability of enabled) {
    for (const method of capabilityRegistry[capability].adapterMethods) {
      if (typeof config.users[method] !== 'function')
        throw new InvalidConfigurationError(
          `users.${method}`,
          `account_kit: users.${method} must be a function`
        )
    }
    for (const path of capabilityRegistry[capability].requiredHooks) {
      const parts = path.split('.')
      const parent =
        parts.length === 1 ? config : config[parts[0] as 'urls' | 'notify' | 'authorize']
      if (typeof (parent as Record<string, unknown> | undefined)?.[parts.at(-1)!] !== 'function')
        throw new InvalidConfigurationError(path, `account_kit: ${path} must be a function`)
    }
  }
  // Login is not a capability, so check the adapter methods it calls when it is configured.
  if (config.authentication)
    for (const method of ['findByEmail', 'findById', 'verifyPassword'] as const)
      if (typeof config.users[method] !== 'function')
        throw new InvalidConfigurationError(
          `users.${method}`,
          `account_kit: users.${method} must be a function`
        )
  if (
    !config.registration ||
    !['open', 'closed', 'application'].includes(config.registration.availability)
  )
    throw new InvalidConfigurationError(
      'registration.availability',
      'account_kit: registration.availability must be open, closed, or application'
    )
  if (
    config.registration.mapFields !== undefined &&
    typeof config.registration.mapFields !== 'function'
  )
    throw new InvalidConfigurationError(
      'registration.mapFields',
      'account_kit: registration.mapFields must be a function'
    )
  if (enabled.includes('magicLinkLogin') && !config.authentication)
    throw new InvalidConfigurationError(
      'magicLinkLogin',
      'account_kit: magicLinkLogin requires authentication'
    )
  if (enabled.includes('socialAuthentication')) validateSocialAuthentication(config, enabled)
  for (const hook of [
    'onInvitationAccepted',
    'onCredentialsChanged',
    'onCredentialsChangedTransaction',
    'onSessionsRevokedTransaction',
    'onPasswordResetIssuedTransaction',
    'onLifecycleEvent',
    'exportAccountData',
    'onAccountDeletingTransaction',
  ] as const) {
    if (config[hook] !== undefined && typeof config[hook] !== 'function')
      throw new InvalidConfigurationError(
        hook,
        `account_kit: ${hook} must be a function when supplied`
      )
  }
  if (config.onCredentialsChanged && config.onCredentialsChangedTransaction)
    throw new InvalidConfigurationError(
      'onCredentialsChanged',
      'account_kit: credential revocation hooks are mutually exclusive'
    )
  const limiterSecret =
    typeof config.limiterSecret === 'string'
      ? config.limiterSecret
      : config.limiterSecret?.release?.()
  if (typeof limiterSecret !== 'string' || Buffer.byteLength(limiterSecret) < 32)
    throw new InvalidConfigurationError(
      'limiterSecret',
      'account_kit: limiterSecret must be a stable shared secret of at least 32 bytes'
    )
  const limiterNamespace = config.limiterNamespace ?? 'default'
  if (
    typeof limiterNamespace !== 'string' ||
    limiterNamespace.length === 0 ||
    limiterNamespace.length > 128
  )
    throw new InvalidConfigurationError(
      'limiterNamespace',
      'account_kit: limiterNamespace must be a non-empty string of at most 128 characters'
    )
  const expiresIn = freezeResolved({
    passwordReset: config.expiresIn?.passwordReset ?? '1h',
    emailVerification: config.expiresIn?.emailVerification ?? '1h',
    invitation: config.expiresIn?.invitation ?? '7d',
    emailChange: config.expiresIn?.emailChange ?? '1h',
    magicLink: config.expiresIn?.magicLink ?? '15m',
  })
  for (const [name, value] of Object.entries(expiresIn))
    configuredExpiresAt(`expiresIn.${name}`, DateTime.utc(), value)
  const throttle = budget(config.throttle, { requests: 5, duration: '15m' }, 'throttle')
  const invitationThrottle = freezeResolved(
    Object.fromEntries(
      ['sendActor', 'sendRecipient', 'resendActor', 'resendInvitation'].map((name) => [
        name,
        budget(
          config.invitationThrottle?.[name as keyof InvitationThrottle],
          { requests: name.endsWith('Actor') ? 10 : 3, duration: '1h' },
          `invitationThrottle.${name}`
        ),
      ])
    )
  ) as unknown as InvitationThrottle
  const minRequestMs = config.minRequestMs ?? 300
  // Node timers overflow above 2^31 - 1 ms and fire after 1 ms instead.
  if (!Number.isFinite(minRequestMs) || minRequestMs < 0 || minRequestMs > 2_147_483_647)
    throw new InvalidConfigurationError(
      'minRequestMs',
      'account_kit: minRequestMs must be a non-negative number of at most 2147483647 milliseconds'
    )
  const tokenSecretLength = config.tokenSecretLength ?? 40
  if (!Number.isSafeInteger(tokenSecretLength) || tokenSecretLength < 16 || tokenSecretLength > 64)
    throw new InvalidConfigurationError(
      'tokenSecretLength',
      'account_kit: tokenSecretLength must be an integer from 16 to 64'
    )
  const passwordPolicy = resolvePasswordPolicy(config)
  const authentication = resolveAuthentication(config)
  if (enabled.includes('sessionManagement') && !authentication)
    throw new InvalidConfigurationError(
      'sessionManagement',
      'account_kit: sessionManagement requires authentication'
    )
  const sessionManagement = resolveSessionManagement(config)
  const accountDeletion = resolveAccountDeletion(config)
  if (
    config.users.resolveMetadata !== undefined &&
    typeof config.users.resolveMetadata !== 'function'
  )
    throw new InvalidConfigurationError(
      'users.resolveMetadata',
      'account_kit: users.resolveMetadata must be a function'
    )
  if (config.users.resolveMetadata && config.usersTable !== undefined)
    throw new InvalidConfigurationError(
      'usersTable',
      'account_kit: usersTable is for custom adapters; the Lucid adapter derives its table'
    )
  if (
    config.emailConstraint !== undefined &&
    (typeof config.emailConstraint !== 'string' || config.emailConstraint.trim() === '')
  )
    throw new InvalidConfigurationError(
      'emailConstraint',
      'account_kit: emailConstraint must be a non-empty constraint name'
    )
  const usersTable = config.usersTable ?? 'users'
  if (!isSqlIdentifier(usersTable))
    throw new InvalidConfigurationError(
      'usersTable',
      'account_kit: usersTable must be a plain SQL identifier'
    )
  const hooks = bindTopLevelHooks(config)
  const { mapFields } = config.registration
  return freezeResolved({
    ...hooks,
    // A copy, so a later write to the application's object cannot skip the checks above.
    // Read by name: a spread would drop an availability defined on a class or prototype.
    registration: freezeResolved({
      availability: config.registration.availability,
      ...(mapFields ? { mapFields: mapFields.bind(config.registration) } : {}),
    }),
    enabled: freezeResolved([...enabled]),
    delivery: config.delivery ?? 'best-effort',
    expiresIn,
    throttle,
    invitationThrottle,
    minRequestMs,
    tokenSecretLength,
    authentication,
    passwordPolicy,
    sessionManagement,
    accountDeletion,
    usersTable,
    limiterSecret,
    limiterNamespace,
    authorize: bindCallbacks<AuthorizationCallbacks>(config.authorize, disabledAuthorize),
    urls: bindCallbacks<UrlCallbacks>(config.urls, disabledUrls),
    notify: bindCallbacks<NotificationCallbacks>(config.notify, disabledNotify),
    onInvitationAccepted:
      typeof config.onInvitationAccepted === 'function'
        ? config.onInvitationAccepted.bind(config)
        : disabled,
  })
}
