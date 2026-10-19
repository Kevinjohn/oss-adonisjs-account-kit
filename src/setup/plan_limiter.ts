// Setup planning phase: limiter store diagnostics.
import type { SetupInspection, SetupDiagnostic } from './types.js'
import { diagnostic } from './shared.js'
import { limiterConfigurationState } from './config_inspection.js'

export async function planLimiter(
  state: SetupInspection,
  diagnostics: SetupDiagnostic[]
): Promise<void> {
  const limiter = await limiterConfigurationState(
    state.files['config/limiter.ts'] ?? '',
    state.root
  )
  if (limiter === 'invalid')
    diagnostic(
      diagnostics,
      'config/limiter.ts',
      'Configure @adonisjs/limiter with pnpm exec node ace configure @adonisjs/limiter; config/limiter.ts needs an actual selected store in its exported defineConfig'
    )
  else if (limiter === 'unresolved')
    diagnostic(
      diagnostics,
      'config/limiter.ts',
      'Selected limiter store is unresolved; use a direct literal or a resolvable environment assignment before activation'
    )
}
