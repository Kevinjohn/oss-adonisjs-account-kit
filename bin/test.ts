import { assert } from '@japa/assert'
import { configure, processCLIArgs, run } from '@japa/runner'

processCLIArgs(process.argv.splice(2))

configure({
  files: ['tests/**/*.spec.ts'],
  // V8 coverage instrumentation slows the setup specs past Japa's 2s default.
  timeout: process.env.NODE_V8_COVERAGE ? 10_000 : undefined,
  plugins: [assert()],
})

run()
