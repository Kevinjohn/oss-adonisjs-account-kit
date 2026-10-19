// Minimum compatibility: run the compatibility fixture against the exact dependency floors.
import { cp, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { databaseEnvironment, installArchive } from './consumer_app.mjs'
import { run } from './harness.mjs'
import { resetExclusivePostgresSchema } from './postgres.mjs'
import { fixtureRoot, tempRoot } from './settings.mjs'

export async function runMinimumCompatibility(candidate, runName) {
  const appRoot = join(tempRoot, runName)
  const compatibilityRoot = join(fixtureRoot, 'compatibility')
  await cp(compatibilityRoot, appRoot, { recursive: true })
  await mkdir(join(appRoot, 'tmp'), { recursive: true })
  const env = databaseEnvironment(appRoot)
  const installed = await installArchive(appRoot, candidate)
  await resetExclusivePostgresSchema(appRoot)
  run('pnpm', ['run', 'typecheck'], appRoot, env)
  run('pnpm', ['run', 'test'], appRoot, env)
  return { appRoot, installed, scenario: 'minimal exact-floor runtime semantics' }
}
