// Setup planning phase: limiter store diagnostics.
import type { SetupInspection, SetupDiagnostic } from './types.js'
import { addSetupDiagnostic } from './shared.js'
import { limiterConfigurationState } from './config_inspection.js'

export async function planLimiter(
  state: SetupInspection,
  diagnostics: SetupDiagnostic[],
  env?: NodeJS.ProcessEnv
): Promise<void> {
  const limiter = await limiterConfigurationState(
    state.files['config/limiter.ts'] ?? '',
    state.root,
    env
  )
  if (limiter === 'invalid')
    addSetupDiagnostic(
      diagnostics,
      'config/limiter.ts',
      'Configure @adonisjs/limiter with pnpm exec node ace configure @adonisjs/limiter; config/limiter.ts needs an actual selected store in its exported defineConfig'
    )
  else if (limiter === 'unresolved')
    addSetupDiagnostic(
      diagnostics,
      'config/limiter.ts',
      'Selected limiter store is unresolved; use a direct literal or a resolvable environment assignment before activation'
    )
}
