import {
  unverifiedActionNames,
  type SetupChoices,
  type SetupDiagnostic,
  type SetupInspection,
} from './types.js'
import { addSetupDiagnostic } from './shared.js'
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from '../password.js'
import { PROTECTED_FIELDS } from '../registration_fields.js'

/** Registration settings, password requirements, access decisions and invitation callbacks. */
export function addPolicyDiagnostics(
  diagnostics: SetupDiagnostic[],
  choices: SetupChoices,
  state: SetupInspection
) {
  const p = choices.policy.password
  if (
    !Number.isInteger(p.minLength) ||
    p.minLength < MIN_PASSWORD_LENGTH ||
    p.minLength > MAX_PASSWORD_LENGTH ||
    (p.maxLength !== null &&
      (!Number.isInteger(p.maxLength) ||
        p.maxLength < p.minLength ||
        p.maxLength > MAX_PASSWORD_LENGTH)) ||
    !Number.isInteger(p.minScore) ||
    p.minScore < 0 ||
    p.minScore > 4
  )
    addSetupDiagnostic(
      diagnostics,
      'policy.password',
      `Use minLength ${MIN_PASSWORD_LENGTH}–${MAX_PASSWORD_LENGTH}, maxLength null or minLength–${MAX_PASSWORD_LENGTH}, and minScore 0–4`
    )
  if (choices.policy.registration === 'open' && !choices.features.includes('registration'))
    addSetupDiagnostic(
      diagnostics,
      'policy.registration',
      'Open registration requires registration to be enabled'
    )
  if (
    choices.managed.includes('registration') &&
    !choices.managedExcept?.includes('auth.signup') &&
    choices.policy.registration !== 'open'
  )
    addSetupDiagnostic(
      diagnostics,
      'policy.registration',
      'Managed public signup requires open registration; use an application-owned route for application admission or omit managed signup when closed'
    )
  // The runtime names, plus names setup refuses because its generated mapper copies client values.
  const protectedFields = new Set([
    ...PROTECTED_FIELDS,
    'isadmin',
    'accesstokens',
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
      addSetupDiagnostic(
        diagnostics,
        `policy.registrationFields.${index}.name`,
        'Field must be a safe application-owned property'
      )
    if (fieldNames.has(field.name))
      addSetupDiagnostic(
        diagnostics,
        `policy.registrationFields.${index}.name`,
        'Registration fields must be unique'
      )
    fieldNames.add(field.name)
    if (!['string', 'number', 'boolean'].includes(field.type))
      addSetupDiagnostic(
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
      addSetupDiagnostic(
        diagnostics,
        `policy.registrationFields.${index}.maxLength`,
        'Use maxLength 1–1024 for a string field'
      )
  }
  if (choices.features.includes('invitations') && !choices.policy.invitationPermissionHook)
    addSetupDiagnostic(
      diagnostics,
      'policy.invitationPermissionHook',
      'Invitation permission callback must be supplied; missing permission denies access'
    )
  if (
    (choices.policy.accessRestrictionHook || choices.features.includes('invitations')) &&
    !state.files['app/services/account_kit_policy.ts']
  )
    addSetupDiagnostic(
      diagnostics,
      'policy',
      'Provide #services/account_kit_policy callbacks before activation'
    )
  else if (choices.policy.accessRestrictionHook || choices.features.includes('invitations'))
    addSetupDiagnostic(
      diagnostics,
      'policy.callbacks',
      'Verify the application-owned policy callbacks implement the selected access and invitation contracts at runtime',
      'action'
    )
  if (choices.authentication && !choices.policy.accessRestrictionHook)
    addSetupDiagnostic(
      diagnostics,
      'policy.accessRestrictionHook',
      'Supply a restricted-account callback for login and managed access'
    )
  if (choices.policy.verificationRequired && !choices.features.includes('emailVerification'))
    addSetupDiagnostic(
      diagnostics,
      'policy.verificationRequired',
      'Verification-gated access requires email verification'
    )
  if (
    choices.features.includes('emailPasswordManagement') &&
    !choices.features.includes('emailVerification')
  )
    addSetupDiagnostic(
      diagnostics,
      'features',
      'Email/password management requires email verification'
    )
  if (choices.features.includes('registration') && !choices.features.includes('emailVerification'))
    addSetupDiagnostic(
      diagnostics,
      'features',
      'Registration requires the email verification service'
    )
  if (choices.policy.verificationRequired) {
    for (const action of unverifiedActionNames) {
      if (!choices.policy.unverifiedActions.includes(action))
        addSetupDiagnostic(
          diagnostics,
          'policy.unverifiedActions',
          `${action} must remain available to unverified accounts`
        )
    }
  }
  if (choices.policy.unverifiedActions.some((action) => !unverifiedActionNames.includes(action)))
    addSetupDiagnostic(diagnostics, 'policy.unverifiedActions', 'Unsupported limited action')
}
