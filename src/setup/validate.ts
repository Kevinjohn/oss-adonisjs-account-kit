import {
  type SetupChoices,
  type SetupDiagnostic,
  type SetupInspection,
  type SetupPlan,
  featureNames,
  userAdapters,
  userIdTypes,
} from './types.ts'
import { sqlName, addSetupDiagnostic } from './shared.ts'
import { addRoutesDiagnostics } from './validate_routes.ts'
import { addAuthenticationDiagnostics } from './validate_authentication.ts'
import { addAccountSettingsDiagnostics } from './validate_account_settings.ts'
import { addMailDiagnostics } from './validate_mail.ts'
import { addSocialDiagnostics } from './validate_social.ts'
import type { SelectedSetupOrigins } from './diagnostics.ts'

export type RetirementOptions = {
  retirementImpact: SetupPlan['retirementImpact']
  retirementMaintenanceWindow: boolean
  runtimeInventoryUnavailable: boolean
}

export type ValidateOptions = RetirementOptions & {
  production: boolean
  /** Deployment values read for readiness. */
  env?: NodeJS.ProcessEnv
  selectedOrigins?: SelectedSetupOrigins
}

export function collectSetupDiagnostics(
  choices: SetupChoices,
  state: SetupInspection,
  options: ValidateOptions
) {
  const { production, env = {}, selectedOrigins } = options
  const diagnostics: SetupDiagnostic[] = []
  if (choices.features.some((x) => !featureNames.includes(x)))
    addSetupDiagnostic(diagnostics, 'features', `Choose from ${featureNames.join(', ')}`)
  if (new Set(choices.features).size !== choices.features.length)
    addSetupDiagnostic(diagnostics, 'features', 'List each feature once')
  if (choices.managed.some((x) => !featureNames.includes(x)))
    addSetupDiagnostic(diagnostics, 'managed', `Choose from ${featureNames.join(', ')}`)
  if (new Set(choices.managed).size !== choices.managed.length)
    addSetupDiagnostic(diagnostics, 'managed', 'List each managed feature once')
  if (choices.managed.some((x) => !choices.features.includes(x)))
    addSetupDiagnostic(
      diagnostics,
      'managed',
      'Every managed feature must have its underlying service enabled'
    )
  if (choices.mode === 'services' && choices.managed.length)
    addSetupDiagnostic(diagnostics, 'managed', 'Services mode cannot mount managed endpoints')
  addRoutesDiagnostics(diagnostics, choices, state)
  // Parsing drops a fixed user field that holds its supported value, so any one left is unsupported.
  const fixed = choices.user as Record<string, unknown>
  if ('connection' in fixed)
    addSetupDiagnostic(
      diagnostics,
      'user.connection',
      'Only the default Lucid connection is supported'
    )
  if (state.database === 'unsupported')
    addSetupDiagnostic(
      diagnostics,
      'database.client',
      'Only SQLite (better-sqlite3), PostgreSQL 16 and MySQL 8.4 (mysql2) are supported'
    )
  if (state.database === 'unknown')
    addSetupDiagnostic(
      diagnostics,
      'database.client',
      'Resolve the selected SQLite, PostgreSQL 16 or MySQL 8.4 client before setup'
    )
  if (!sqlName.test(choices.user.table))
    addSetupDiagnostic(diagnostics, 'user.table', 'Use a plain SQL identifier')
  if (!userAdapters.includes(choices.user.adapter))
    addSetupDiagnostic(diagnostics, 'user.adapter', 'Choose lucid or custom')
  if (!userIdTypes.includes(choices.user.idType))
    addSetupDiagnostic(diagnostics, 'user.idType', 'Choose integer, string or uuid')
  if (['primaryKey', 'emailColumn', 'passwordColumn', 'verifiedColumn'].some((key) => key in fixed))
    addSetupDiagnostic(
      diagnostics,
      'user',
      'Only the physical id, email, password and email_verified_at columns are supported'
    )
  if (
    !/^#models\/[A-Za-z_][A-Za-z0-9_/]*$/.test(choices.user.model) ||
    choices.user.model.includes('//')
  )
    addSetupDiagnostic(
      diagnostics,
      'user.model',
      'Use an application #models/ import with a safe path'
    )
  if (choices.user.adapter === 'custom')
    addSetupDiagnostic(
      diagnostics,
      'user.adapter',
      'Verify custom adapter normalization, unique email, password hashing, transactions and row locking before activation',
      'action'
    )
  if (choices.user.adapter === 'custom' && !state.files['app/services/account_kit_users.ts'])
    addSetupDiagnostic(
      diagnostics,
      'user.adapter',
      'Provide #services/account_kit_users before activation'
    )
  addAuthenticationDiagnostics(diagnostics, choices, state, production)
  addAccountSettingsDiagnostics(diagnostics, choices, state)
  addMailDiagnostics(diagnostics, choices, state, production, env, selectedOrigins)
  addSocialDiagnostics(diagnostics, choices, state, production, env, selectedOrigins)
  addRetirementDiagnostics(diagnostics, choices, state, options)
  if (state.existingPrefix && state.existingPrefix !== choices.routePrefix)
    addSetupDiagnostic(
      diagnostics,
      'routePrefix',
      'Changing the managed prefix needs an explicit route transition; review clients before reconfiguration',
      'action'
    )
  return diagnostics
}

/** Blocks login-method retirement unless the read-only inventory proves it is safe. */
function addRetirementDiagnostics(
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
    addSetupDiagnostic(
      diagnostics,
      'authentication.retirement',
      'Booted login-method inventory is unavailable; verify Account Kit configuration and database access before reconfiguration'
    )
  if (providerRetirement || passwordRetirement) {
    const field = providerRetirement ? 'social.retirement' : 'authentication.retirement'
    if (!retirementImpact)
      addSetupDiagnostic(
        diagnostics,
        field,
        'Read-only retirement impact count is unavailable; verify Account Kit provider, configuration and database access, then retry'
      )
    else if (retirementImpact.affectedAccounts > 0)
      addSetupDiagnostic(
        diagnostics,
        field,
        `${retirementImpact.affectedAccounts} of ${retirementImpact.inspectedAccounts} accounts would lose their last usable login; complete an owner-managed credential migration before retrying`
      )
    else if (!retirementMaintenanceWindow)
      addSetupDiagnostic(
        diagnostics,
        field,
        'Zero affected accounts were found, but retirement requires --retirement-maintenance-window to prevent concurrent credential changes'
      )
  }
}
