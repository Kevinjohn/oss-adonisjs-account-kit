import type { SetupChoices } from './types.js'
import { DateTime } from 'luxon'
import { expiresAt } from '../ttl.js'

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

function string(value: unknown, path: string): void {
  if (typeof value !== 'string') throw new Error(`${path}: expected a string`)
}

function bool(value: unknown, path: string): void {
  if (typeof value !== 'boolean') throw new Error(`${path}: expected a boolean`)
}

function strings(value: unknown, path: string): void {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string'))
    throw new Error(`${path}: expected a string array`)
}

/** Reject unknown fields so a deployment secret cannot be silently written to the setup file. */
export function parseSetupChoices(input: unknown): SetupChoices {
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
  strings(root.features, 'features')
  strings(root.managed, 'managed')
  if (root.managedExcept !== undefined) strings(root.managedExcept, 'managedExcept')
  string(root.mode, 'mode')
  if (!['services', 'managed'].includes(root.mode as string))
    throw new Error('mode: choose services or managed')
  if (root.version !== 1) throw new Error('version: expected 1')
  string(root.routePrefix, 'routePrefix')
  const user = record(root.user, 'user', [
    'model',
    'table',
    'idType',
    'adapter',
    'connection',
    'primaryKey',
    'emailColumn',
    'passwordColumn',
    'verifiedColumn',
  ])
  for (const [key, value] of Object.entries(user)) string(value, `user.${key}`)
  if (root.authentication !== null) {
    const auth = record(
      root.authentication,
      'authentication',
      ['strategy', 'guard', 'applicationRouteRevocation'],
      ['session', 'token']
    )
    string(auth.strategy, 'authentication.strategy')
    if (!['session', 'access_tokens'].includes(auth.strategy as string))
      throw new Error('authentication.strategy: choose session or access_tokens')
    string(auth.guard, 'authentication.guard')
    bool(auth.applicationRouteRevocation, 'authentication.applicationRouteRevocation')
    const optional = root.authentication as Record<string, unknown>
    if ('session' in optional) {
      const session = record(optional.session, 'authentication.session', [
        'secureCookie',
        'csrf',
        'originChecked',
        'persistentStore',
      ])
      for (const [key, value] of Object.entries(session))
        bool(value, `authentication.session.${key}`)
    }
    if ('token' in optional) {
      const token = record(optional.token, 'authentication.token', [
        'revocation',
        'lifetime',
        'abilities',
      ])
      bool(token.revocation, 'authentication.token.revocation')
      string(token.lifetime, 'authentication.token.lifetime')
      strings(token.abilities, 'authentication.token.abilities')
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
  const mail = record(root.mail, 'mail', [
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
    string(mail[key], `mail.${key}`)
  for (const key of ['senderEnv', 'transportEnv']) {
    if (mail[key] !== null) string(mail[key], `mail.${key}`)
  }
  bool(mail.durableWorkerVerified, 'mail.durableWorkerVerified')
  const destinations = mail.destinations
  if (!destinations || typeof destinations !== 'object' || Array.isArray(destinations))
    throw new Error('mail.destinations: expected an object')
  for (const [key, value] of Object.entries(destinations)) {
    if (!['emailVerification', 'passwordReset', 'invitation', 'emailChange'].includes(key))
      throw new Error(`mail.destinations.${key}: unsupported field`)
    string(value, `mail.destinations.${key}`)
  }
  const policy = record(root.policy, 'policy', [
    'registration',
    'registrationFields',
    'password',
    'verificationRequired',
    'unverifiedActions',
    'invitationPermissionHook',
    'accessRestrictionHook',
  ])
  string(policy.registration, 'policy.registration')
  if (!['open', 'closed', 'application'].includes(policy.registration as string))
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
    string(field.name, `policy.registrationFields.${index}.name`)
    string(field.type, `policy.registrationFields.${index}.type`)
    bool(field.required, `policy.registrationFields.${index}.required`)
    if ('maxLength' in field && typeof field.maxLength !== 'number')
      throw new Error(`policy.registrationFields.${index}.maxLength: expected a number`)
  }
  strings(policy.unverifiedActions, 'policy.unverifiedActions')
  for (const key of ['verificationRequired', 'invitationPermissionHook', 'accessRestrictionHook'])
    bool(policy[key], `policy.${key}`)
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
    bool(password[key], `policy.password.${key}`)
  const social = root.social
  if (!social || typeof social !== 'object' || Array.isArray(social))
    throw new Error('social: expected an object')
  const status = (social as Record<string, unknown>).status
  if (status === 'enabled') {
    const selected = record(social, 'social', [
      'status',
      'providers',
      'callbackOriginEnv',
      'callbackPath',
      'credentials',
    ])
    strings(selected.providers, 'social.providers')
    string(selected.callbackOriginEnv, 'social.callbackOriginEnv')
    string(selected.callbackPath, 'social.callbackPath')
    const credentials = record(selected.credentials, 'social.credentials', [], ['google', 'github'])
    for (const [provider, value] of Object.entries(credentials)) {
      const entry = record(value, `social.credentials.${provider}`, [
        'clientIdEnv',
        'clientSecretEnv',
      ])
      string(entry.clientIdEnv, `social.credentials.${provider}.clientIdEnv`)
      string(entry.clientSecretEnv, `social.credentials.${provider}.clientSecretEnv`)
    }
  } else if (status === 'not-applicable') {
    const skipped = record(social, 'social', ['status', 'reason'])
    string(skipped.reason, 'social.reason')
  } else throw new Error('social.status: expected enabled or not-applicable')
  return input as SetupChoices
}
