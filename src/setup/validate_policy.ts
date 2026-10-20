import {
  unverifiedActionNames,
  type SetupChoices,
  type SetupDiagnostic,
  type SetupInspection,
} from './types.js'
import { diagnostic } from './shared.js'

/** Password, registration, callback and unverified-account policy. */
export function validatePolicy(
  diagnostics: SetupDiagnostic[],
  choices: SetupChoices,
  state: SetupInspection
) {
  const p = choices.policy.password
  if (
    !Number.isInteger(p.minLength) ||
    p.minLength < 8 ||
    p.minLength > 256 ||
    (p.maxLength !== null &&
      (!Number.isInteger(p.maxLength) || p.maxLength < p.minLength || p.maxLength > 256)) ||
    !Number.isInteger(p.minScore) ||
    p.minScore < 0 ||
    p.minScore > 4
  )
    diagnostic(
      diagnostics,
      'policy.password',
      'Use minLength 8–256, maxLength null or minLength–256, and minScore 0–4'
    )
  for (const key of ['letters', 'mixedCase', 'numbers', 'symbols'] as const) {
    if (typeof p[key] !== 'boolean')
      diagnostic(diagnostics, `policy.password.${key}`, 'Use a boolean')
  }
  if (choices.policy.registration === 'open' && !choices.features.includes('registration'))
    diagnostic(
      diagnostics,
      'policy.registration',
      'Open registration requires registration to be enabled'
    )
  if (
    choices.managed.includes('registration') &&
    !choices.managedExcept?.includes('auth.signup') &&
    choices.policy.registration !== 'open'
  )
    diagnostic(
      diagnostics,
      'policy.registration',
      'Managed public signup requires open registration; use an application-owned route for application admission or omit managed signup when closed'
    )
  const protectedFields = new Set([
    'id',
    'email',
    'password',
    'passwordhash',
    'password_hash',
    'unverifiedemail',
    'unverified_email',
    'emailverifiedat',
    'email_verified_at',
    'role',
    'roles',
    'isadmin',
    'accesstokens',
    'credentialschangedat',
    '__proto__',
    'prototype',
    'constructor',
  ])
  const fieldNames = new Set<string>()
  for (const [index, field] of choices.policy.registrationFields.entries()) {
    if (
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(field.name) ||
      protectedFields.has(field.name.toLowerCase())
    )
      diagnostic(
        diagnostics,
        `policy.registrationFields.${index}.name`,
        'Field must be a safe application-owned property'
      )
    if (fieldNames.has(field.name))
      diagnostic(
        diagnostics,
        `policy.registrationFields.${index}.name`,
        'Registration fields must be unique'
      )
    fieldNames.add(field.name)
    if (!['string', 'number', 'boolean'].includes(field.type))
      diagnostic(
        diagnostics,
        `policy.registrationFields.${index}.type`,
        'Choose string, number or boolean'
      )
    if (
      field.maxLength !== undefined &&
      (field.type !== 'string' ||
        !Number.isInteger(field.maxLength) ||
        field.maxLength < 1 ||
        field.maxLength > 1024)
    )
      diagnostic(
        diagnostics,
        `policy.registrationFields.${index}.maxLength`,
        'Use maxLength 1–1024 for a string field'
      )
  }
  if (choices.features.includes('invitations') && !choices.policy.invitationPermissionHook)
    diagnostic(
      diagnostics,
      'policy.invitationPermissionHook',
      'Invitation permission callback must be supplied; missing permission denies access'
    )
  if (
    (choices.policy.accessRestrictionHook || choices.features.includes('invitations')) &&
    !state.files['app/services/account_kit_policy.ts']
  )
    diagnostic(
      diagnostics,
      'policy',
      'Provide #services/account_kit_policy callbacks before activation'
    )
  else if (choices.policy.accessRestrictionHook || choices.features.includes('invitations'))
    diagnostic(
      diagnostics,
      'policy.callbacks',
      'Verify the application-owned policy callbacks implement the selected access and invitation contracts at runtime',
      'action'
    )
  if (choices.authentication && !choices.policy.accessRestrictionHook)
    diagnostic(
      diagnostics,
      'policy.accessRestrictionHook',
      'Supply a restricted-account callback for login and managed access'
    )
  if (choices.policy.verificationRequired && !choices.features.includes('emailVerification'))
    diagnostic(
      diagnostics,
      'policy.verificationRequired',
      'Verification-gated access requires email verification'
    )
  if (
    choices.features.includes('emailPasswordManagement') &&
    !choices.features.includes('emailVerification')
  )
    diagnostic(diagnostics, 'features', 'Email/password management requires email verification')
  if (choices.features.includes('registration') && !choices.features.includes('emailVerification'))
    diagnostic(diagnostics, 'features', 'Registration requires the email verification service')
  if (choices.policy.verificationRequired) {
    for (const action of unverifiedActionNames) {
      if (!choices.policy.unverifiedActions.includes(action))
        diagnostic(
          diagnostics,
          'policy.unverifiedActions',
          `${action} must remain available to unverified accounts`
        )
    }
  }
  if (choices.policy.unverifiedActions.some((action) => !unverifiedActionNames.includes(action)))
    diagnostic(diagnostics, 'policy.unverifiedActions', 'Unsupported limited action')
}
