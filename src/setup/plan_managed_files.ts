import type { SetupChoices, SetupFileChange, SetupInspection, SetupDiagnostic } from './types.ts'
import { addSetupDiagnostic } from './shared.ts'
import { recordOwnedChange } from './changes.ts'
import {
  generateDisabledRoutesSource,
  resolveRouteSource,
  generateManagedGuardSource,
  generateAccessMiddlewareSource,
  generateProofHeadersMiddlewareSource,
} from './generated_sources.ts'

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
    addSetupDiagnostic(
      diagnostics,
      'authentication.retirement',
      'Review application-owned routes for the generated account access middleware and remove or replace their references after authentication retirement',
      'action'
    )
  if (
    choices.authentication &&
    (choices.managed.length || state.files['app/services/account_kit_guard.ts'])
  ) {
    recordOwnedChange(
      changes,
      state,
      'app/services/account_kit_guard.ts',
      generateManagedGuardSource(choices),
      priorGenerated?.authentication ? generateManagedGuardSource(priorGenerated) : null,
      'Adapt the selected existing AdonisJS guard'
    )
    recordOwnedChange(
      changes,
      state,
      'app/middleware/account_kit_access_middleware.ts',
      generateAccessMiddlewareSource(choices),
      priorGenerated?.authentication ? generateAccessMiddlewareSource(priorGenerated) : null,
      'Offer the same account revision and restriction gate to application-owned routes'
    )
  }
  if (choices.managed.length && choices.authentication) {
    recordOwnedChange(
      changes,
      state,
      'start/account_kit_routes.ts',
      resolveRouteSource(choices),
      state.existingChoices?.authentication && state.existingChoices.managed.length
        ? resolveRouteSource(state.existingChoices)
        : retainedChoices
          ? generateDisabledRoutesSource(retainedChoices)
          : null,
      'Mount selected maintained endpoints through the existing guard'
    )
  } else if (state.existingChoices?.managed.length && state.existingChoices.authentication) {
    recordOwnedChange(
      changes,
      state,
      'start/account_kit_routes.ts',
      generateDisabledRoutesSource(state.existingChoices),
      resolveRouteSource(state.existingChoices),
      'Retire the managed route mount without changing application routes or account data'
    )
  }
  if (
    choices.managed.length ||
    state.files['app/middleware/account_kit_proof_headers_middleware.ts']
  ) {
    recordOwnedChange(
      changes,
      state,
      'app/middleware/account_kit_proof_headers_middleware.ts',
      generateProofHeadersMiddlewareSource(choices),
      state.existingChoices ? generateProofHeadersMiddlewareSource(state.existingChoices) : null,
      'Protect proof responses before parser and CSRF failures'
    )
  }
}
