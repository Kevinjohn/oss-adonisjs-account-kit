import type { SetupChoices, SetupFileChange, SetupInspection, SetupDiagnostic } from './types.js'
import { diagnostic } from './shared.js'
import { ownedChange } from './changes.js'
import {
  disabledManagedRoutesSource,
  selectedRouteSource,
  managedGuardSource,
  managedAccessMiddlewareSource,
  proofHeadersMiddlewareSource,
} from './generated_sources.js'

export function planManagedFiles(
  choices: SetupChoices,
  state: SetupInspection,
  diagnostics: SetupDiagnostic[],
  changes: SetupFileChange[],
  priorGenerated: SetupChoices | null,
  retainedChoices: SetupChoices | null
): void {
  if (
    !choices.authentication &&
    state.existingChoices?.authentication &&
    state.files['app/middleware/account_kit_access_middleware.ts']
  )
    diagnostic(
      diagnostics,
      'authentication.retirement',
      'Review application-owned routes for the generated account access middleware and remove or replace their references after authentication retirement',
      'action'
    )
  if (
    choices.authentication &&
    (choices.managed.length || state.files['app/services/account_kit_guard.ts'])
  ) {
    ownedChange(
      changes,
      state,
      'app/services/account_kit_guard.ts',
      managedGuardSource(choices),
      priorGenerated?.authentication ? managedGuardSource(priorGenerated) : null,
      'Adapt the selected existing AdonisJS guard'
    )
    ownedChange(
      changes,
      state,
      'app/middleware/account_kit_access_middleware.ts',
      managedAccessMiddlewareSource(choices),
      priorGenerated?.authentication ? managedAccessMiddlewareSource(priorGenerated) : null,
      'Offer the same account revision and restriction gate to application-owned routes'
    )
  }
  if (choices.managed.length && choices.authentication) {
    ownedChange(
      changes,
      state,
      'start/account_kit_routes.ts',
      selectedRouteSource(choices),
      state.existingChoices?.authentication && state.existingChoices.managed.length
        ? selectedRouteSource(state.existingChoices)
        : retainedChoices
          ? disabledManagedRoutesSource(retainedChoices)
          : null,
      'Mount selected maintained endpoints through the existing guard'
    )
  } else if (state.existingChoices?.managed.length && state.existingChoices.authentication) {
    ownedChange(
      changes,
      state,
      'start/account_kit_routes.ts',
      disabledManagedRoutesSource(state.existingChoices),
      selectedRouteSource(state.existingChoices),
      'Retire the managed route mount without changing application routes or account data'
    )
  }
  if (
    choices.managed.length ||
    state.files['app/middleware/account_kit_proof_headers_middleware.ts']
  ) {
    ownedChange(
      changes,
      state,
      'app/middleware/account_kit_proof_headers_middleware.ts',
      proofHeadersMiddlewareSource(choices),
      state.existingChoices ? proofHeadersMiddlewareSource(state.existingChoices) : null,
      'Protect proof responses before parser and CSRF failures'
    )
  }
}
