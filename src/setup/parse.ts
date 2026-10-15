import type { SetupChoices } from './types.js'

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
  const root = record(input, 'setup', [
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
  ])
  strings(root.features, 'features')
  strings(root.managed, 'managed')
  string(root.mode, 'mode')
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
  if (status === 'approved-pending') {
    const approved = record(social, 'social', ['status', 'providers'])
    strings(approved.providers, 'social.providers')
  } else if (status === 'not-applicable') {
    const skipped = record(social, 'social', ['status', 'reason'])
    string(skipped.reason, 'social.reason')
  } else throw new Error('social.status: expected approved-pending or not-applicable')
  return input as SetupChoices
}
