// The dependencies every account service is built from.
import type { Database } from '@adonisjs/lucid/database'
import type { LimiterService } from '@adonisjs/limiter/types'
import type { Throttler } from './throttle.js'
import type { ResolvedConfig } from './types.js'

export type ServiceDependencies = {
  config: ResolvedConfig
  db: Database
  limiter: LimiterService
  throttler?: Throttler
}
