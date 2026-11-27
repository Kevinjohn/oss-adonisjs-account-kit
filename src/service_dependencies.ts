// The dependencies every account service is built from.
import type { Database } from '@adonisjs/lucid/database'
import type { LimiterService } from '@adonisjs/limiter/types'
import type { ExportFaults } from './account_export.ts'
import type { CorrectionRevisions } from './profile_correction_revision.ts'
import type { RevocationOutcomes } from './session_revocation.ts'
import type { Throttler } from './throttle.ts'
import type { ResolvedConfig } from './types.ts'

export type ServiceDependencies = {
  config: ResolvedConfig
  db: Database
  limiter: LimiterService
  throttler: Throttler
  exportFaults: ExportFaults
  revocationOutcomes: RevocationOutcomes
  correctionRevisions: CorrectionRevisions
}
