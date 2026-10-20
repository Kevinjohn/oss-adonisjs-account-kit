import { RuntimeException } from '@adonisjs/core/exceptions'
import { DateTime } from 'luxon'
import { CapabilityDisabledError } from './errors.js'
import { budget } from './config_budget.js'
import { assertPlainObject } from './config_assert.js'
import { isSqlIdentifier } from './sql_identifier.js'
import { capabilities, capabilityRegistry, defaultCapabilities } from './capabilities.js'
import { resolveAuthentication } from './config_authentication.js'
import { resolvePasswordPolicy } from './config_password_policy.js'
import { resolveAccountDeletion } from './config_account_deletion.js'
import { resolveSessionManagement } from './config_session_management.js'
import { validateSocialAuthentication } from './config_social_authentication.js'
import { expiresAt } from './ttl.js'
import type {
  AccountKitConfig,
  AuthorizationCallbacks,
  InvitationThrottle,
  NotificationCallbacks,
  ResolvedConfig,
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
 * Validates the Account Kit config and fills in defaults. Throws at boot, with the field name, for
 * a missing callback an enabled capability needs or an out-of-range value.
 */
export function defineConfig(config: AccountKitConfig): ResolvedConfig {
  if (!config || typeof config !== 'object' || !config.users || typeof config.users !== 'object')
    throw new RuntimeException('account_kit: users adapter must be configured')
  if (
    config.delivery !== undefined &&
    !['best-effort', 'durable', 'capture'].includes(config.delivery)
  )
    throw new RuntimeException('account_kit: delivery must be best-effort, durable, or capture')
  const enabled = config.enabled ?? defaultCapabilities
  if (
    !Array.isArray(enabled) ||
    new Set(enabled).size !== enabled.length ||
    enabled.some((name) => !capabilities.includes(name))
  )
    throw new RuntimeException(
      'account_kit: enabled must contain unique supported capability names'
    )
  if (enabled.includes('emailPasswordManagement') && !enabled.includes('emailVerification'))
    throw new RuntimeException('account_kit: emailPasswordManagement requires emailVerification')
  for (const name of ['authorize', 'urls', 'notify', 'expiresIn', 'invitationThrottle'] as const) {
    if (config[name] !== undefined) assertPlainObject(config[name], name)
  }
  for (const capability of enabled) {
    for (const method of capabilityRegistry[capability].adapterMethods) {
      if (typeof config.users[method] !== 'function')
        throw new RuntimeException(`account_kit: users.${method} must be a function`)
    }
    for (const path of capabilityRegistry[capability].requiredHooks) {
      const parts = path.split('.')
      const parent =
        parts.length === 1 ? config : config[parts[0] as 'urls' | 'notify' | 'authorize']
      if (typeof (parent as Record<string, unknown> | undefined)?.[parts.at(-1)!] !== 'function')
        throw new RuntimeException(`account_kit: ${path} must be a function`)
    }
  }
  if (
    !config.registration ||
    !['open', 'closed', 'application'].includes(config.registration.availability)
  )
    throw new RuntimeException(
      'account_kit: registration.availability must be open, closed, or application'
    )
  if (
    config.registration.mapFields !== undefined &&
    typeof config.registration.mapFields !== 'function'
  )
    throw new RuntimeException('account_kit: registration.mapFields must be a function')
  if (enabled.includes('magicLinkLogin') && !config.authentication)
    throw new RuntimeException('account_kit: magicLinkLogin requires authentication')
  if (enabled.includes('socialAuthentication')) validateSocialAuthentication(config, enabled)
  for (const hook of [
    'onInvitationAccepted',
    'onCredentialsChanged',
    'onCredentialsChangedTransaction',
    'onPasswordResetIssuedTransaction',
    'onLifecycleEvent',
    'exportAccountData',
    'onAccountDeletingTransaction',
  ] as const) {
    if (config[hook] !== undefined && typeof config[hook] !== 'function')
      throw new RuntimeException(`account_kit: ${hook} must be a function when supplied`)
  }
  if (config.onCredentialsChanged && config.onCredentialsChangedTransaction)
    throw new RuntimeException('account_kit: credential revocation hooks are mutually exclusive')
  if (typeof config.limiterSecret !== 'string' || Buffer.byteLength(config.limiterSecret) < 32)
    throw new RuntimeException(
      'account_kit: limiterSecret must be a stable shared secret of at least 32 bytes'
    )
  const limiterNamespace = config.limiterNamespace ?? 'default'
  if (
    typeof limiterNamespace !== 'string' ||
    limiterNamespace.length === 0 ||
    limiterNamespace.length > 128
  )
    throw new RuntimeException(
      'account_kit: limiterNamespace must be a non-empty string of at most 128 characters'
    )
  const expiresIn = {
    passwordReset: config.expiresIn?.passwordReset ?? '1h',
    emailVerification: config.expiresIn?.emailVerification ?? '1h',
    invitation: config.expiresIn?.invitation ?? '7d',
    emailChange: config.expiresIn?.emailChange ?? '1h',
    magicLink: config.expiresIn?.magicLink ?? '15m',
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
    throw new RuntimeException('account_kit: minRequestMs must be a finite non-negative number')
  const tokenSecretLength = config.tokenSecretLength ?? 40
  if (!Number.isSafeInteger(tokenSecretLength) || tokenSecretLength < 16 || tokenSecretLength > 64)
    throw new RuntimeException('account_kit: tokenSecretLength must be an integer from 16 to 64')
  const passwordPolicy = resolvePasswordPolicy(config)
  const authentication = resolveAuthentication(config)
  if (enabled.includes('sessionManagement') && !authentication)
    throw new RuntimeException('account_kit: sessionManagement requires authentication')
  const sessionManagement = resolveSessionManagement(config)
  const accountDeletion = resolveAccountDeletion(config)
  if (
    config.users.resolveMetadata !== undefined &&
    typeof config.users.resolveMetadata !== 'function'
  )
    throw new RuntimeException('account_kit: users.resolveMetadata must be a function')
  if (config.users.resolveMetadata && config.usersTable !== undefined)
    throw new RuntimeException(
      'account_kit: usersTable is for custom adapters; the Lucid adapter derives its table'
    )
  if (
    config.emailConstraint !== undefined &&
    (typeof config.emailConstraint !== 'string' || config.emailConstraint.trim() === '')
  )
    throw new RuntimeException('account_kit: emailConstraint must be a non-empty constraint name')
  const usersTable = config.usersTable ?? 'users'
  if (!isSqlIdentifier(usersTable))
    throw new RuntimeException('account_kit: usersTable must be a plain SQL identifier')
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
    accountDeletion,
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
