import { guardStrategies, registrationPolicies, setupModes, type SetupChoices } from './types.js'
import { DateTime } from 'luxon'
import { expiresAt } from '../ttl.js'
import { socialProviderNames } from '../social_providers.js'

function record(
  input: unknown,
  path: string,
  keys: readonly string[],
  optional: readonly string[] = []
): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error(`${path}: expected an object`)
  const value = input as Record<string, unknown>
  for (const key of Object.keys(value)) {
    if (!keys.includes(key) && !optional.includes(key))
      throw new Error(`${path}.${key}: unsupported field`)
  }
  for (const key of keys) {
    if (!(key in value)) throw new Error(`${path}.${key}: required field is missing`)
  }
  return value
}

function assertString(value: unknown, path: string): void {
  if (typeof value !== 'string') throw new Error(`${path}: expected a string`)
}

function assertBoolean(value: unknown, path: string): void {
  if (typeof value !== 'boolean') throw new Error(`${path}: expected a boolean`)
}

function assertStringArray(value: unknown, path: string): void {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string'))
    throw new Error(`${path}: expected a string array`)
}

/** Fields earlier setup files recorded with their only supported value. */
export const fixedUserFields = {
  connection: 'default',
  primaryKey: 'id',
  emailColumn: 'email',
  passwordColumn: 'password',
  verifiedColumn: 'email_verified_at',
} as const

/** Drops each fixed field holding its supported value; any other value stays for validation. */
function parseUser(input: unknown): Record<string, unknown> {
  const user = record(
    input,
    'user',
    ['model', 'table', 'idType', 'adapter'],
    Object.keys(fixedUserFields)
  )
  for (const [key, value] of Object.entries(user)) assertString(value, `user.${key}`)
  return Object.fromEntries(
    Object.entries(user).filter(
      ([key, value]) => fixedUserFields[key as keyof typeof fixedUserFields] !== value
    )
  )
}

function assertAuthenticationChoices(input: unknown): void {
  if (input === null) return
  const auth = record(
    input,
    'authentication',
    ['strategy', 'guard', 'applicationRouteRevocation'],
    ['session', 'token']
  )
  assertString(auth.strategy, 'authentication.strategy')
  if (!(guardStrategies as readonly string[]).includes(auth.strategy as string))
    throw new Error('authentication.strategy: choose session or access_tokens')
  assertString(auth.guard, 'authentication.guard')
  assertBoolean(auth.applicationRouteRevocation, 'authentication.applicationRouteRevocation')
  const optional = input as Record<string, unknown>
  if ('session' in optional) {
    const session = record(optional.session, 'authentication.session', [
      'secureCookie',
      'csrf',
      'originChecked',
      'persistentStore',
    ])
    for (const [key, value] of Object.entries(session))
      assertBoolean(value, `authentication.session.${key}`)
  }
  if ('token' in optional) {
    const token = record(optional.token, 'authentication.token', [
      'revocation',
      'lifetime',
      'abilities',
    ])
    assertBoolean(token.revocation, 'authentication.token.revocation')
    assertString(token.lifetime, 'authentication.token.lifetime')
    assertStringArray(token.abilities, 'authentication.token.abilities')
    if (
      !(token.abilities as string[]).length ||
      (token.abilities as string[]).some((value) => !value.trim())
    )
      throw new Error('authentication.token.abilities: provide non-empty abilities')
    try {
      expiresAt(DateTime.utc(), token.lifetime as string)
    } catch {
      throw new Error('authentication.token.lifetime: provide a supported positive duration')
    }
  }
}

function assertMailChoices(input: unknown): void {
  const mail = record(input, 'mail', [
    'integration',
    'delivery',
    'senderEnv',
    'transportEnv',
    'appName',
    'backendOriginEnv',
    'frontendOriginEnv',
    'destinations',
    'durableWorkerVerified',
  ])
  for (const key of ['integration', 'delivery', 'appName', 'backendOriginEnv', 'frontendOriginEnv'])
    assertString(mail[key], `mail.${key}`)
  for (const key of ['senderEnv', 'transportEnv']) {
    if (mail[key] !== null) assertString(mail[key], `mail.${key}`)
  }
  assertBoolean(mail.durableWorkerVerified, 'mail.durableWorkerVerified')
  const destinations = mail.destinations
  if (!destinations || typeof destinations !== 'object' || Array.isArray(destinations))
    throw new Error('mail.destinations: expected an object')
  for (const [key, value] of Object.entries(destinations)) {
    if (
      !['emailVerification', 'passwordReset', 'invitation', 'emailChange', 'magicLink'].includes(
        key
      )
    )
      throw new Error(`mail.destinations.${key}: unsupported field`)
    assertString(value, `mail.destinations.${key}`)
  }
}

function assertPolicyChoices(input: unknown): void {
  const policy = record(input, 'policy', [
    'registration',
    'registrationFields',
    'password',
    'verificationRequired',
    'unverifiedActions',
    'invitationPermissionHook',
    'accessRestrictionHook',
  ])
  assertString(policy.registration, 'policy.registration')
  if (!(registrationPolicies as readonly string[]).includes(policy.registration as string))
    throw new Error('policy.registration: choose open, closed or application')
  if (!Array.isArray(policy.registrationFields))
    throw new Error('policy.registrationFields: expected an array')
  for (const [index, inputField] of policy.registrationFields.entries()) {
    const field = record(
      inputField,
      `policy.registrationFields.${index}`,
      ['name', 'type', 'required'],
      ['maxLength']
    )
    assertString(field.name, `policy.registrationFields.${index}.name`)
    assertString(field.type, `policy.registrationFields.${index}.type`)
    assertBoolean(field.required, `policy.registrationFields.${index}.required`)
    if ('maxLength' in field && typeof field.maxLength !== 'number')
      throw new Error(`policy.registrationFields.${index}.maxLength: expected a number`)
  }
  assertStringArray(policy.unverifiedActions, 'policy.unverifiedActions')
  for (const key of ['verificationRequired', 'invitationPermissionHook', 'accessRestrictionHook'])
    assertBoolean(policy[key], `policy.${key}`)
  const password = record(policy.password, 'policy.password', [
    'minLength',
    'maxLength',
    'letters',
    'mixedCase',
    'numbers',
    'symbols',
    'minScore',
  ])
  for (const key of ['minLength', 'minScore']) {
    if (typeof password[key] !== 'number')
      throw new Error(`policy.password.${key}: expected a number`)
  }
  if (password.maxLength !== null && typeof password.maxLength !== 'number')
    throw new Error('policy.password.maxLength: expected a number or null')
  for (const key of ['letters', 'mixedCase', 'numbers', 'symbols'])
    assertBoolean(password[key], `policy.password.${key}`)
}

function assertSocialChoices(input: unknown): void {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('social: expected an object')
  const status = (input as Record<string, unknown>).status
  if (status === 'enabled') {
    const selected = record(input, 'social', [
      'status',
      'providers',
      'callbackOriginEnv',
      'callbackPath',
      'credentials',
    ])
    assertStringArray(selected.providers, 'social.providers')
    assertString(selected.callbackOriginEnv, 'social.callbackOriginEnv')
    assertString(selected.callbackPath, 'social.callbackPath')
    const credentials = record(selected.credentials, 'social.credentials', [], socialProviderNames)
    for (const [provider, value] of Object.entries(credentials)) {
      const entry = record(value, `social.credentials.${provider}`, [
        'clientIdEnv',
        'clientSecretEnv',
      ])
      assertString(entry.clientIdEnv, `social.credentials.${provider}.clientIdEnv`)
      assertString(entry.clientSecretEnv, `social.credentials.${provider}.clientSecretEnv`)
    }
  } else if (status === 'not-applicable') {
    const skipped = record(input, 'social', ['status', 'reason'])
    assertString(skipped.reason, 'social.reason')
  } else throw new Error('social.status: expected enabled or not-applicable')
}

/** Reject unknown fields so a deployment secret cannot be silently written to the setup file. */
export function requireSetupChoices(input: unknown): SetupChoices {
  const root = record(
    input,
    'setup',
    [
      'version',
      'mode',
      'features',
      'managed',
      'routePrefix',
      'user',
      'authentication',
      'mail',
      'policy',
      'social',
    ],
    ['managedExcept']
  )
  assertStringArray(root.features, 'features')
  assertStringArray(root.managed, 'managed')
  if (root.managedExcept !== undefined) assertStringArray(root.managedExcept, 'managedExcept')
  assertString(root.mode, 'mode')
  if (!(setupModes as readonly string[]).includes(root.mode as string))
    throw new Error('mode: choose services or managed')
  if (root.version !== 1) throw new Error('version: expected 1')
  assertString(root.routePrefix, 'routePrefix')
  const user = parseUser(root.user)
  assertAuthenticationChoices(root.authentication)
  assertMailChoices(root.mail)
  assertPolicyChoices(root.policy)
  assertSocialChoices(root.social)
  return { ...root, user } as unknown as SetupChoices
}
