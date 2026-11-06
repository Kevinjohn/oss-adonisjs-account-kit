import { assert } from '@japa/assert'
import { configure, processCLIArgs, run } from '@japa/runner'

processCLIArgs(process.argv.splice(2))

configure({
  files: ['tests/**/*.spec.ts'],
  // Coverage instrumentation and MySQL integration schema rebuilds can exceed Japa's 2s default.
  timeout: process.env.NODE_V8_COVERAGE || process.env.DB_CLIENT === 'mysql2' ? 10_000 : undefined,
  plugins: [assert()],
})

run()
