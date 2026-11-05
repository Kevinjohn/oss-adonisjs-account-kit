import env from '#start/env'
import app from '@adonisjs/core/services/app'
import { defineConfig, stores } from '@adonisjs/limiter'

// A memory store counts per process, so several instances would each allow the full budget.
if (app.inProduction && env.get('LIMITER_STORE') === 'memory')
  throw new Error('LIMITER_STORE=memory is for tests; use database in production')

const limiterConfig = defineConfig({
  default: env.get('LIMITER_STORE'),
  stores: {
    /** Stores rate limits in the configured database, including SQLite. */
    database: stores.database({
      tableName: 'rate_limits',
    }),

    /** Keeps rate limits in the current process. */
    memory: stores.memory({}),
  },
})

export default limiterConfig

declare module '@adonisjs/limiter/types' {
  export interface LimitersList extends InferLimiters<typeof limiterConfig> {}
}
