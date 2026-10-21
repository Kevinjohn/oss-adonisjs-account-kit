import {
  type SetupChoices,
  type SetupDiagnostic,
  type SetupInspection,
  type SetupPlan,
  featureNames,
  setupModes,
  userAdapters,
  userIdTypes,
} from './types.js'
import { sqlName, diagnostic } from './shared.js'
import { validateRoutes } from './validate_routes.js'
import { validateAuthentication } from './validate_authentication.js'
import { validatePolicy } from './validate_policy.js'
import { validateMail } from './validate_mail.js'
import { validateSocial } from './validate_social.js'
import type { SelectedSetupOrigins } from './diagnostics.js'

export type RetirementOptions = {
  retirementImpact: SetupPlan['retirementImpact']
  retirementMaintenanceWindow: boolean
  runtimeInventoryUnavailable: boolean
}

export type ValidateOptions = RetirementOptions & {
  production: boolean
  /** Deployment values read for readiness; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv
  selectedOrigins?: SelectedSetupOrigins
}

export function validate(choices: SetupChoices, state: SetupInspection, options: ValidateOptions) {
  const { production, env = process.env, selectedOrigins } = options
  const diagnostics: SetupDiagnostic[] = []
  if (choices.version !== 1) diagnostic(diagnostics, 'version', 'Supported setup version is 1')
  if (!setupModes.includes(choices.mode))
    diagnostic(diagnostics, 'mode', 'Choose services or managed')
  if (!Array.isArray(choices.features) || choices.features.some((x) => !featureNames.includes(x)))
    diagnostic(diagnostics, 'features', `Choose from ${featureNames.join(', ')}`)
  if (new Set(choices.features).size !== choices.features.length)
    diagnostic(diagnostics, 'features', 'List each feature once')
  if (!Array.isArray(choices.managed) || choices.managed.some((x) => !featureNames.includes(x)))
    diagnostic(diagnostics, 'managed', `Choose from ${featureNames.join(', ')}`)
  if (new Set(choices.managed).size !== choices.managed.length)
    diagnostic(diagnostics, 'managed', 'List each managed feature once')
  if (choices.managed.some((x) => !choices.features.includes(x)))
    diagnostic(
      diagnostics,
      'managed',
      'Every managed feature must have its underlying service enabled'
    )
  if (choices.mode === 'services' && choices.managed.length)
    diagnostic(diagnostics, 'managed', 'Services mode cannot mount managed endpoints')
  validateRoutes(diagnostics, choices, state)
  if (choices.user.connection !== 'default')
    diagnostic(diagnostics, 'user.connection', 'Only the default Lucid connection is supported')
  if (state.database === 'unsupported')
    diagnostic(
      diagnostics,
      'database.client',
      'Only SQLite, PostgreSQL 16 and MySQL 8.4 (mysql2) are supported'
    )
  if (state.database === 'unknown')
    diagnostic(
      diagnostics,
      'database.client',
      'Resolve the selected SQLite, PostgreSQL 16 or MySQL 8.4 client before setup'
    )
  if (!sqlName.test(choices.user.table))
    diagnostic(diagnostics, 'user.table', 'Use a plain SQL identifier')
  if (!userAdapters.includes(choices.user.adapter))
    diagnostic(diagnostics, 'user.adapter', 'Choose lucid or custom')
  if (!userIdTypes.includes(choices.user.idType))
    diagnostic(diagnostics, 'user.idType', 'Choose integer, string or uuid')
  if (
    choices.user.primaryKey !== 'id' ||
    choices.user.emailColumn !== 'email' ||
    choices.user.passwordColumn !== 'password' ||
    choices.user.verifiedColumn !== 'email_verified_at'
  )
    diagnostic(
      diagnostics,
      'user',
      'Only the physical id, email, password and email_verified_at columns are supported'
    )
  if (
    !/^#models\/[A-Za-z_][A-Za-z0-9_/]*$/.test(choices.user.model) ||
    choices.user.model.includes('//')
  )
    diagnostic(diagnostics, 'user.model', 'Use an application #models/ import with a safe path')
  if (choices.user.adapter === 'custom')
    diagnostic(
      diagnostics,
      'user.adapter',
      'Verify custom adapter normalization, unique email, password hashing, transactions and row locking before activation',
      'action'
    )
  if (choices.user.adapter === 'custom' && !state.files['app/services/account_kit_users.ts'])
    diagnostic(diagnostics, 'user.adapter', 'Provide #services/account_kit_users before activation')
  validateAuthentication(diagnostics, choices, state, production)
  validatePolicy(diagnostics, choices, state)
  validateMail(diagnostics, choices, state, production, env, selectedOrigins)
  validateSocial(diagnostics, choices, state, production, env, selectedOrigins)
  retirementDiagnostics(diagnostics, choices, state, options)
  if (state.existingPrefix && state.existingPrefix !== choices.routePrefix)
    diagnostic(
      diagnostics,
      'routePrefix',
      'Changing the managed prefix needs an explicit route transition; review clients before reconfiguration',
      'action'
    )
  return diagnostics
}

/** Blocks login-method retirement unless the read-only inventory proves it is safe. */
function retirementDiagnostics(
  diagnostics: SetupDiagnostic[],
  choices: SetupChoices,
  state: SetupInspection,
  { retirementImpact, retirementMaintenanceWindow, runtimeInventoryUnavailable }: RetirementOptions
) {
  const beforeProviders =
    retirementImpact?.currentProviders ??
    (state.existingChoices?.social.status === 'enabled'
      ? state.existingChoices.social.providers
      : [])
  const afterProviders = choices.social.status === 'enabled' ? choices.social.providers : []
  const providerRetirement = beforeProviders.some((provider) => !afterProviders.includes(provider))
  const passwordRetirement =
    (retirementImpact?.currentPasswordLogin ?? Boolean(state.existingChoices?.authentication)) &&
    !choices.authentication
  if (runtimeInventoryUnavailable && state.existingChoices)
    diagnostic(
      diagnostics,
      'authentication.retirement',
      'Booted login-method inventory is unavailable; verify Account Kit configuration and database access before reconfiguration'
    )
  if (providerRetirement || passwordRetirement) {
    const field = providerRetirement ? 'social.retirement' : 'authentication.retirement'
    if (!retirementImpact)
      diagnostic(
        diagnostics,
        field,
        'Read-only retirement impact count is unavailable; verify Account Kit provider, configuration and database access, then retry'
      )
    else if (retirementImpact.affectedAccounts > 0)
      diagnostic(
        diagnostics,
        field,
        `${retirementImpact.affectedAccounts} of ${retirementImpact.inspectedAccounts} accounts would lose their last usable login; complete an owner-managed credential migration before retrying`
      )
    else if (!retirementMaintenanceWindow)
      diagnostic(
        diagnostics,
        field,
        'Zero affected accounts were found, but retirement requires --retirement-maintenance-window to prevent concurrent credential changes'
      )
  }
}
