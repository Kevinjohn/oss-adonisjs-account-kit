// Setup planning phase: Shield CSRF and session store diagnostics for managed session guards.
import type { SetupChoices, SetupInspection, SetupDiagnostic } from './types.js'
import { diagnostic } from './shared.js'
import { shieldCsrfState } from './config_inspection.js'
import {
  type NativeSessionConfiguration,
  nativeSessionConfiguration,
  unwrapManagedSessionConfig,
} from './session_config.js'
import { selectedSessionDiagnostic } from './session_diagnostics.js'

export async function planSession(
  choices: SetupChoices,
  state: SetupInspection,
  diagnostics: SetupDiagnostic[],
  options: { production?: boolean }
): Promise<void> {
  if (choices.authentication?.strategy === 'session') {
    const shieldConfig = state.files['config/shield.ts']
    const csrf = shieldConfig ? await shieldCsrfState(shieldConfig) : 'missing'
    if (csrf === 'missing' || csrf === 'false')
      diagnostic(
        diagnostics,
        'config/shield.ts',
        'Session managed POSTs require configured Shield CSRF protection'
      )
    else if (csrf === 'dynamic')
      diagnostic(
        diagnostics,
        'config/shield.ts',
        'Verify that Shield csrf.enabled resolves true at runtime for the selected session guard; conventional environment-gated configuration requires ACCOUNT_KIT_AUTH_STRATEGY=session',
        'action'
      )
    if (!state.files['config/session.ts'])
      diagnostic(
        diagnostics,
        'config/session.ts',
        'Session guard requires configured cookie and session storage'
      )
    else {
      let inspected: NativeSessionConfiguration | null = null
      let diagnosticSelection: { name: string | null; kind: string | null } | null = null
      try {
        const current = state.files['config/session.ts']
        const baseline = current.includes('account-kit:session-import:start')
          ? await unwrapManagedSessionConfig(current, state.root)
          : current
        if (baseline) {
          inspected = await nativeSessionConfiguration(baseline, state.root)
          diagnosticSelection = inspected
            ? { name: inspected.selectedName, kind: inspected.selected?.kind ?? null }
            : await selectedSessionDiagnostic(baseline, state.root)
        }
      } catch {
        // The integration diagnostic above already blocks an uninspectable selection.
      }
      if (diagnosticSelection?.kind === 'cookie')
        diagnostic(
          diagnostics,
          'config/session.ts',
          'Cookie-only sessions cannot enforce logout replay protection; select a server-side session store'
        )
      else if (options.production && diagnosticSelection?.kind === 'memory')
        diagnostic(
          diagnostics,
          'config/session.ts',
          'Production requires a persistent shared session store; selected memory storage cannot satisfy persistentStore verification'
        )
      else if (
        diagnosticSelection?.kind === 'database' &&
        !state.migrationNames.some((name) => /session/i.test(name))
      )
        diagnostic(
          diagnostics,
          'config/session.ts',
          'Database session storage requires an application session-table migration and a verified applied table',
          'action'
        )
      else if (diagnosticSelection?.name && !diagnosticSelection.kind)
        diagnostic(
          diagnostics,
          'config/session.ts',
          'Selected session store is not configured in config/session.ts'
        )
      else if (options.production && !diagnosticSelection?.kind)
        diagnostic(
          diagnostics,
          'config/session.ts',
          'Production session storage must be a verified persistent server-side store'
        )
      else if (!inspected?.selected)
        diagnostic(
          diagnostics,
          'config/session.ts',
          'Verify the selected runtime session store resolves to a server-side implementation and preserves logout revocation across requests',
          'action'
        )
    }
  }
}
