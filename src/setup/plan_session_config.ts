// Setup planning phase: wrap or retire the managed session store verification in config/session.ts.
import type { SetupChoices, SetupDiagnostic, SetupFileChange, SetupInspection } from './types.js'
import { defaultExpression, importedName, parseSetupSource } from './ts_source.js'
import { diagnostic } from './shared.js'
import {
  type NativeSessionConfiguration,
  nativeSessionConfiguration,
  renderManagedSessionConfig,
  unwrapManagedSessionConfig,
} from './session_config.js'

export async function planSessionConfigIntegration(
  changes: SetupFileChange[],
  state: SetupInspection,
  choices: SetupChoices,
  diagnostics: SetupDiagnostic[]
): Promise<void> {
  const path = 'config/session.ts'
  const previous = state.files[path]
  if (!previous) return
  const wantsManagedSession =
    choices.managed.length > 0 && choices.authentication?.strategy === 'session'
  const wasManaged = previous.includes('account-kit:session-import:start')
  const base = wasManaged ? await unwrapManagedSessionConfig(previous, state.root) : previous
  if (base === null) {
    diagnostic(
      diagnostics,
      path,
      'The managed session integration was edited; restore its marked block or reconcile it manually before setup'
    )
    return
  }
  if (!wantsManagedSession && !wasManaged) return
  const parsed = await parseSetupSource(previous)
  const existingWrapper = defaultExpression(parsed)
  const wrapperBinding = importedName(
    parsed,
    'adonisjs-account-kit/http',
    'protectManagedSessionConfig'
  )
  if (
    !wasManaged &&
    wrapperBinding &&
    existingWrapper &&
    parsed.ts.isCallExpression(existingWrapper.expression) &&
    parsed.ts.isIdentifier(existingWrapper.expression.expression) &&
    existingWrapper.expression.expression.text === wrapperBinding
  ) {
    diagnostic(
      diagnostics,
      path,
      'Verify the existing application-owned session protection wrapper before enabling managed session routes',
      'action'
    )
    return
  }
  let inspected: NativeSessionConfiguration | null = null
  if (wantsManagedSession) {
    try {
      inspected = await nativeSessionConfiguration(base, state.root)
    } catch {
      diagnostic(
        diagnostics,
        path,
        'Inspect the selected session environment assignment and file path; only a direct native store name is supported'
      )
      return
    }
  }
  if (wantsManagedSession && !inspected?.selected) {
    diagnostic(
      diagnostics,
      path,
      'The selected session factory must be an inspected native database or development memory store; custom or unresolved selections need a truthful application-owned protectManagedSessionConfig wrapper'
    )
    return
  }
  const content =
    wantsManagedSession && inspected ? renderManagedSessionConfig(base, inspected) : base
  if (content === null) {
    diagnostic(
      diagnostics,
      path,
      'Use a conventional const sessionConfig = defineConfig(...) and export default sessionConfig, or wire protectManagedSessionConfig manually before managed session activation'
    )
    return
  }
  changes.push({
    path,
    action: previous === content ? 'unchanged' : 'update',
    expected: previous,
    content,
    reason: wantsManagedSession
      ? 'Verify the selected server-side session store before issuing managed credentials'
      : 'Retire the setup-owned managed session verification wrapper',
  })
}
