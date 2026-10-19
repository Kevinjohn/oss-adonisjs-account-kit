// Command-line options and paths shared by every packed-consumer scenario.
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
export const fixtureRoot = join(repoRoot, 'examples/api')
const nodeMajor = Number(process.versions.node.split('.')[0])

if (nodeMajor !== 24) {
  throw new Error(`Node 24 is required; current runtime is ${process.versions.node}`)
}

function option(name, fallback) {
  const prefix = `--${name}=`
  const arg = process.argv.find((value) => value.startsWith(prefix))
  return arg ? arg.slice(prefix.length) : fallback
}

export const mode = option('mode', 'fresh')
export const database = option('database', 'sqlite')
export const compatibility = option('compatibility', 'latest')
export const userIdType = option('user-id-type', 'integer')
export const usersTable = option('users-table', 'users')
export const prepareOnly = process.argv.includes('--prepare-only')
export const candidateInput = option('candidate-tarball', process.env.CANDIDATE_TARBALL)
export const candidateRevision = option('candidate-revision', process.env.CANDIDATE_REVISION)
const supportedModes = new Set(['fresh', 'minimum', 'service-only'])

if (!supportedModes.has(mode)) throw new Error(`Unknown mode: ${mode}`)
if (prepareOnly && mode !== 'fresh') {
  throw new Error('--prepare-only supports fresh mode only')
}
if (mode === 'minimum' && compatibility !== 'minimum') {
  throw new Error('--mode=minimum requires --compatibility=minimum')
}
if (compatibility === 'minimum' && mode !== 'minimum') {
  throw new Error('--compatibility=minimum requires --mode=minimum')
}
if (!['sqlite', 'postgres'].includes(database)) throw new Error(`Unknown database: ${database}`)
if (!['minimum', 'latest'].includes(compatibility)) {
  throw new Error(`Unknown compatibility set: ${compatibility}`)
}
if (!['integer', 'string', 'uuid'].includes(userIdType)) {
  throw new Error(`Unknown user ID type: ${userIdType}`)
}
if (!/^[a-z][a-z0-9_]*$/.test(usersTable))
  throw new Error(`Invalid users table name: ${usersTable}`)
if (mode !== 'fresh' && (userIdType !== 'integer' || usersTable !== 'users')) {
  throw new Error('Minimum and service-only runs currently require the default integer users table')
}

export const tempRoot = await mkdtemp(join(tmpdir(), 'account-kit-consumer-'))

export const secret = process.env.DB_PASSWORD ?? ''
