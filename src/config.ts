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
  ResolvedConfig,
  ThrottleBudget,
  UrlCallbacks,
} from './types.js'

const capabilities: Capability[] = [
  'passwordReset',
  'emailVerification',
  'invitations',
  'emailPasswordManagement',
]
const adapterMethods: Record<Capability, string[]> = {
  passwordReset: ['findByEmail', 'findById', 'setPassword', 'markEmailVerified'],
  emailVerification: ['findById', 'markEmailVerified'],
  invitations: ['findByEmail', 'findById', 'create'],
  emailPasswordManagement: [
    'findByEmail',
    'findById',
    'setPassword',
    'setEmail',
    'markEmailVerified',
    'verifyPassword',
  ],
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
    'notify.emailChangeProvision',
    'notify.emailChanged',
    'notify.passwordChanged',
  ],
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
  const enabled = config.enabled ?? capabilities
  if (
    !Array.isArray(enabled) ||
    new Set(enabled).size !== enabled.length ||
    enabled.some((name) => !capabilities.includes(name))
  )
    throw new Error('account_kit: enabled must contain unique supported capability names')
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
    expiresIn,
    throttle,
    invitationThrottle,
    minRequestMs,
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
      ...config.notify,
    } as NotificationCallbacks,
    onInvitationAccepted: config.onInvitationAccepted ?? disabled,
  }
}
