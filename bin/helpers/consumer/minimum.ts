// Minimum compatibility: run the compatibility fixture against the exact dependency floors.
import { cp, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { databaseEnvironment, installArchive } from './consumer_app.js'
import { run } from './harness.js'
import { resetExclusivePostgresSchema } from './postgres.js'
import { fixtureRoot, tempRoot } from './settings.js'

export async function runMinimumCompatibility(candidate: string, runName: string) {
  const appRoot = join(tempRoot, runName)
  const compatibilityRoot = join(fixtureRoot, 'compatibility')
  await cp(compatibilityRoot, appRoot, { recursive: true })
  await mkdir(join(appRoot, 'tmp'), { recursive: true })
  const env = databaseEnvironment(appRoot)
  const installed = await installArchive(appRoot, candidate)
  await resetExclusivePostgresSchema(appRoot)
  run('pnpm', ['run', 'typecheck'], appRoot, env)
  run('pnpm', ['run', 'test:entry-points'], appRoot, env)
  run('pnpm', ['run', 'test:ace'], appRoot, env)
  run('pnpm', ['run', 'test'], appRoot, env)
  return {
    appRoot,
    installed,
    scenario: 'minimal exact-floor entry points, Ace command loading and runtime semantics',
  }
}
