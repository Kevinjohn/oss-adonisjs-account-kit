import { configProvider } from '@adonisjs/core'
import { resolveRegisteredCallbacks } from './config_resolution.ts'
import { DateTime } from 'luxon'
import { ActionUrls } from './action_urls.ts'
import { E_ACCOUNT_KIT_CAPABILITY_DISABLED, E_ACCOUNT_KIT_INVALID_CONFIGURATION } from './errors.ts'
import { resolveThrottleBudget } from './config_budget.ts'
import { assertObject } from './config_assert.ts'
import { isSqlIdentifier } from './sql_identifier.ts'
import { capabilities, capabilityRequirements, defaultCapabilities } from './capabilities.ts'
import { resolveAuthentication } from './config_authentication.ts'
import { resolvePasswordRules } from './config_password_rules.ts'
import { resolveAccountDeletion } from './config_account_deletion.ts'
import { resolveSessionManagement } from './config_session_management.ts'
import { assertSocialAuthenticationConfig } from './config_social_authentication.ts'
import { computeConfiguredExpiry } from './config_ttl.ts'
import type {
  AccountKitConfig,
  AuthorizationCallbacks,
  InvitationThrottle,
  NotificationCallbacks,
  ResolvedConfig,
  UrlCallbacks,
} from './types.ts'
import { freezeResolved } from './config_freeze.ts'

function rejectDisabledCapability(): never {
  throw new E_ACCOUNT_KIT_CAPABILITY_DISABLED('This account capability is disabled')
}

const disabledAuthorize: Record<keyof AuthorizationCallbacks, typeof rejectDisabledCapability> = {
  invite: rejectDisabledCapability,
  manageInvitation: rejectDisabledCapability,
  listInvitations: rejectDisabledCapability,
}
const disabledUrls: Record<keyof UrlCallbacks, typeof rejectDisabledCapability> = {
  passwordReset: rejectDisabledCapability,
  emailVerification: rejectDisabledCapability,
  invitation: rejectDisabledCapability,
  emailChange: rejectDisabledCapability,
  magicLink: rejectDisabledCapability,
}
const disabledNotify: Record<keyof NotificationCallbacks, typeof rejectDisabledCapability> = {
  passwordResetProvision: rejectDisabledCapability,
  passwordResetCompleted: rejectDisabledCapability,
  accountActivationProvision: rejectDisabledCapability,
  invitationProvision: rejectDisabledCapability,
  emailChangeProvision: rejectDisabledCapability,
  emailChanged: rejectDisabledCapability,
  passwordChanged: rejectDisabledCapability,
  socialIdentityLinked: rejectDisabledCapability,
  socialIdentityUnlinked: rejectDisabledCapability,
  magicLinkProvision: rejectDisabledCapability,
  accountDeleted: rejectDisabledCapability,
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

/**
 * Validates the Account Kit config and fills in defaults. Throws at boot, with the field name, for
 * a missing callback an enabled capability needs or an out-of-range value. `users`, `authorize` and
 * `onInvitationAccepted` may be left out for `AccountKitCallbackConfiguration` to supply; they are
 * checked when the service is first resolved.
 *
 * @example
 * ```ts
 * import { defineConfig } from '@kevinjohn/adonisjs-account-kit'
 * import env from '#start/env'
 * import { createLucidAdapter } from '@kevinjohn/adonisjs-account-kit/adapters/lucid'
 *
 * export default defineConfig({
 *   enabled: [],
 *   users: createLucidAdapter(async () => (await import('#models/user')).default),
 *   urls: {},
 *   notify: {},
 *   limiterSecret: env.get('APP_KEY'),
 *   registration: { availability: 'closed' },
 * })
 * ```
 */
export function defineConfig(config: AccountKitConfig) {
  const preliminary = resolveConfig(config, true)
  return configProvider.create((app) => resolveRegisteredCallbacks(app, config, preliminary))
}

/**
 * The checks and defaults of `defineConfig`. With `deferCallbacks`, a field the callback registry
 * can supply is not required yet.
 */
export function resolveConfig(config: AccountKitConfig, deferCallbacks = true): ResolvedConfig {
  if (
    !config ||
    typeof config !== 'object' ||
    (!(deferCallbacks && config.users === undefined) &&
      (!config.users || typeof config.users !== 'object'))
  )
    throw new E_ACCOUNT_KIT_INVALID_CONFIGURATION(
      'users',
      'account_kit: users adapter must be configured'
    )
  if (
    config.delivery !== undefined &&
    !['best-effort', 'durable', 'capture'].includes(config.delivery)
  )
    throw new E_ACCOUNT_KIT_INVALID_CONFIGURATION(
      'delivery',
      'account_kit: delivery must be best-effort, durable, or capture'
    )
  const enabled = config.enabled ?? defaultCapabilities
  if (
    !Array.isArray(enabled) ||
    new Set(enabled).size !== enabled.length ||
    enabled.some((name) => !capabilities.includes(name))
  )
    throw new E_ACCOUNT_KIT_INVALID_CONFIGURATION(
      'enabled',
      'account_kit: enabled must contain unique supported capability names'
    )
  if (enabled.includes('emailPasswordManagement') && !enabled.includes('emailVerification'))
    throw new E_ACCOUNT_KIT_INVALID_CONFIGURATION(
      'emailPasswordManagement',
      'account_kit: emailPasswordManagement requires emailVerification'
    )
  for (const name of ['authorize', 'urls', 'notify', 'expiresIn', 'invitationThrottle'] as const) {
    if (config[name] !== undefined) assertObject(config[name], name)
  }
  if (config.users?.hashPassword !== undefined) {
    if (typeof config.users.hashPassword !== 'function')
      throw new E_ACCOUNT_KIT_INVALID_CONFIGURATION(
        'users.hashPassword',
        'account_kit: users.hashPassword must be a function'
      )
    if (typeof config.users.setPasswordHash !== 'function')
      throw new E_ACCOUNT_KIT_INVALID_CONFIGURATION(
        'users.setPasswordHash',
        'account_kit: users.setPasswordHash must be a function when users.hashPassword is set'
      )
  }
  for (const capability of enabled) {
    for (const method of capabilityRequirements[capability].adapterMethods) {
      if (config.users && typeof config.users[method] !== 'function')
        throw new E_ACCOUNT_KIT_INVALID_CONFIGURATION(
          `users.${method}`,
          `account_kit: users.${method} must be a function`
        )
    }
    for (const path of capabilityRequirements[capability].requiredHooks) {
      const parts = path.split('.')
      if (
        deferCallbacks &&
        (parts[0] === 'authorize' || parts[0] === 'onInvitationAccepted') &&
        config[parts[0]] === undefined
      )
        continue
      const parent =
        parts.length === 1 ? config : config[parts[0] as 'urls' | 'notify' | 'authorize']
      if (typeof (parent as Record<string, unknown> | undefined)?.[parts.at(-1)!] !== 'function')
        throw new E_ACCOUNT_KIT_INVALID_CONFIGURATION(
          path,
          `account_kit: ${path} must be a function`
        )
    }
  }
  if (
    !config.registration ||
    !['open', 'closed', 'application'].includes(config.registration.availability)
  )
    throw new E_ACCOUNT_KIT_INVALID_CONFIGURATION(
      'registration.availability',
      'account_kit: registration.availability must be open, closed, or application'
    )
  if (
    config.registration.mapFields !== undefined &&
    typeof config.registration.mapFields !== 'function'
  )
    throw new E_ACCOUNT_KIT_INVALID_CONFIGURATION(
      'registration.mapFields',
      'account_kit: registration.mapFields must be a function'
    )
  if (enabled.includes('magicLinkLogin') && !config.authentication)
    throw new E_ACCOUNT_KIT_INVALID_CONFIGURATION(
      'magicLinkLogin',
      'account_kit: magicLinkLogin requires authentication'
    )
  if (enabled.includes('socialAuthentication')) assertSocialAuthenticationConfig(config, enabled)
  for (const hook of [
    'onInvitationAccepted',
    'onCredentialsChanged',
    'onCredentialsChangedTransaction',
    'onSessionsRevokedTransaction',
    'onPasswordResetIssuedTransaction',
    'onLifecycleNotification',
    'exportAccountData',
    'onAccountDeletingTransaction',
  ] as const) {
    if (config[hook] !== undefined && typeof config[hook] !== 'function')
      throw new E_ACCOUNT_KIT_INVALID_CONFIGURATION(
        hook,
        `account_kit: ${hook} must be a function when supplied`
      )
  }
  if (config.onCredentialsChanged && config.onCredentialsChangedTransaction)
    throw new E_ACCOUNT_KIT_INVALID_CONFIGURATION(
      'onCredentialsChanged',
      'account_kit: onCredentialsChanged and onCredentialsChangedTransaction are mutually exclusive'
    )
  const limiterSecret =
    typeof config.limiterSecret === 'string'
      ? config.limiterSecret
      : config.limiterSecret?.release?.()
  if (typeof limiterSecret !== 'string' || Buffer.byteLength(limiterSecret) < 32)
    throw new E_ACCOUNT_KIT_INVALID_CONFIGURATION(
      'limiterSecret',
      'account_kit: limiterSecret must be a stable shared secret of at least 32 bytes'
    )
  const limiterNamespace = config.limiterNamespace ?? 'default'
  if (
    typeof limiterNamespace !== 'string' ||
    limiterNamespace.length === 0 ||
    limiterNamespace.length > 128
  )
    throw new E_ACCOUNT_KIT_INVALID_CONFIGURATION(
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
    computeConfiguredExpiry(`expiresIn.${name}`, DateTime.utc(), value)
  const throttle = resolveThrottleBudget(
    config.throttle,
    { requests: 5, duration: '15m' },
    'throttle'
  )
  const invitationThrottle = freezeResolved(
    Object.fromEntries(
      ['sendActor', 'sendRecipient', 'resendActor', 'resendInvitation'].map((name) => [
        name,
        resolveThrottleBudget(
          config.invitationThrottle?.[name as keyof InvitationThrottle],
          { requests: name.endsWith('Actor') ? 10 : 3, duration: '1h' },
          `invitationThrottle.${name}`
        ),
      ])
    )
  ) as unknown as InvitationThrottle
  const minRequestMs = config.minRequestMs ?? 300
  if (!Number.isFinite(minRequestMs) || minRequestMs < 0)
    throw new E_ACCOUNT_KIT_INVALID_CONFIGURATION(
      'minRequestMs',
      'account_kit: minRequestMs must be a finite non-negative number'
    )
  const tokenSecretLength = config.tokenSecretLength ?? 40
  if (!Number.isSafeInteger(tokenSecretLength) || tokenSecretLength < 16 || tokenSecretLength > 64)
    throw new E_ACCOUNT_KIT_INVALID_CONFIGURATION(
      'tokenSecretLength',
      'account_kit: tokenSecretLength must be an integer from 16 to 64'
    )
  const passwordPolicy = resolvePasswordRules(config)
  const authentication = resolveAuthentication(config)
  if (enabled.includes('sessionManagement') && !authentication)
    throw new E_ACCOUNT_KIT_INVALID_CONFIGURATION(
      'sessionManagement',
      'account_kit: sessionManagement requires authentication'
    )
  const sessionManagement = resolveSessionManagement(config)
  const accountDeletion = resolveAccountDeletion(config)
  if (
    config.users?.resolveMetadata !== undefined &&
    typeof config.users.resolveMetadata !== 'function'
  )
    throw new E_ACCOUNT_KIT_INVALID_CONFIGURATION(
      'users.resolveMetadata',
      'account_kit: users.resolveMetadata must be a function'
    )
  if (config.users?.resolveMetadata && config.usersTable !== undefined)
    throw new E_ACCOUNT_KIT_INVALID_CONFIGURATION(
      'usersTable',
      'account_kit: usersTable is for custom adapters; the Lucid adapter derives its table'
    )
  if (
    config.emailConstraint !== undefined &&
    (typeof config.emailConstraint !== 'string' || config.emailConstraint.trim() === '')
  )
    throw new E_ACCOUNT_KIT_INVALID_CONFIGURATION(
      'emailConstraint',
      'account_kit: emailConstraint must be a non-empty constraint name'
    )
  const usersTable = config.usersTable ?? 'users'
  if (!isSqlIdentifier(usersTable))
    throw new E_ACCOUNT_KIT_INVALID_CONFIGURATION(
      'usersTable',
      'account_kit: usersTable must be a plain SQL identifier'
    )
  const { mapFields } = config.registration
  // Action URLs fill every callback and keep the backend origin `doctor` reports.
  const urls =
    config.urls instanceof ActionUrls
      ? freezeResolved(config.urls)
      : bindCallbacks<UrlCallbacks>(config.urls, disabledUrls)
  return freezeResolved({
    // Deferred only by `defineConfig`, whose result `resolveAccountKitConfig` checks again.
    users: config.users!,
    emailConstraint: config.emailConstraint,
    socialAuthentication: config.socialAuthentication,
    onCredentialsChanged: config.onCredentialsChanged?.bind(config),
    onCredentialsChangedTransaction: config.onCredentialsChangedTransaction?.bind(config),
    onSessionsRevokedTransaction: config.onSessionsRevokedTransaction?.bind(config),
    onPasswordResetIssuedTransaction: config.onPasswordResetIssuedTransaction?.bind(config),
    onLifecycleNotification: config.onLifecycleNotification?.bind(config),
    exportAccountData: config.exportAccountData?.bind(config),
    onAccountDeletingTransaction: config.onAccountDeletingTransaction?.bind(config),
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
    urls,
    notify: bindCallbacks<NotificationCallbacks>(config.notify, disabledNotify),
    onInvitationAccepted:
      typeof config.onInvitationAccepted === 'function'
        ? config.onInvitationAccepted.bind(config)
        : rejectDisabledCapability,
  })
}
