#!/usr/bin/env node

import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

interface CommandRecord {
  command: string
  args: string[]
  cwd: string
  exitCode: number | null
}

interface LogRecord {
  command: string
  text: string
}

interface ConsumerEvidence {
  revision: string
  sourceChanges: string
  candidateRevision: string | null
  runtime: string
  packageManager: string
  database: string
  compatibility: string
  userIdType: string
  usersTable: string
  prepareOnly: boolean
  mode: string
  commands: CommandRecord[]
  runs: unknown[]
  status: 'incomplete' | 'failed' | 'passed'
  candidateTarball?: string
  candidateSha256?: string
  error?: string
  logs?: LogRecord[]
}

function option(name: string, fallback: string): string
function option(name: string, fallback?: string): string | undefined
function option(name: string, fallback?: string) {
  const prefix = '--' + name + '='
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length) ?? fallback
}

function errorMessage(error: unknown) {
  return error instanceof Error ? (error.stack ?? error.message) : String(error)
}

const secret = process.env.DB_PASSWORD ?? ''
const redact = (value: unknown) => {
  const text = String(value)
  return secret ? text.split(secret).join('[REDACTED]') : text
}

function redactStrings(value: unknown): unknown {
  if (typeof value === 'string') return redact(value)
  if (Array.isArray(value)) return value.map(redactStrings)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, redactStrings(entry)])
    )
  }
  return value
}

function redactedEvidence(value: ConsumerEvidence): ConsumerEvidence {
  const sanitized = redactStrings(value) as ConsumerEvidence
  sanitized.status = value.status
  return sanitized
}

const candidateInput = option('candidate-tarball', process.env.CANDIDATE_TARBALL)
const configuredCandidateRevision = option('candidate-revision', process.env.CANDIDATE_REVISION)

let evidencePath = process.env.CONSUMER_EVIDENCE_PATH
  ? resolve(process.env.CONSUMER_EVIDENCE_PATH)
  : undefined
let tempRoot: string | undefined
let commands: CommandRecord[] = []
let logs: LogRecord[] = []
let failure: unknown
let collectionFailure: AggregateError | undefined

const evidence: ConsumerEvidence = {
  revision: 'unavailable',
  sourceChanges: 'unavailable',
  candidateRevision:
    configuredCandidateRevision ?? (candidateInput ? 'unknown external archive revision' : null),
  runtime: process.versions.node,
  packageManager: 'unavailable',
  database: option('database', 'sqlite'),
  compatibility: option('compatibility', 'latest'),
  userIdType: option('user-id-type', 'integer'),
  usersTable: option('users-table', 'users'),
  prepareOnly: process.argv.includes('--prepare-only'),
  mode: option('mode', 'fresh'),
  commands,
  runs: [],
  status: 'incomplete',
}

try {
  const settings = await import('./helpers/consumer/settings.js')
  tempRoot = settings.tempRoot
  evidencePath ??= join(tempRoot, 'evidence.json')
  evidence.database = settings.database
  evidence.compatibility = settings.compatibility
  evidence.userIdType = settings.userIdType
  evidence.usersTable = settings.usersTable
  evidence.prepareOnly = settings.prepareOnly
  evidence.mode = settings.mode

  const harness = await import('./helpers/consumer/harness.js')
  commands = harness.commands
  logs = harness.output
  evidence.commands = commands
  evidence.logs = logs

  evidence.revision = harness.run('git', ['rev-parse', 'HEAD'], settings.repoRoot).trim()
  evidence.sourceChanges = harness.run('git', ['status', '--short'], settings.repoRoot).trim()
  evidence.runtime = process.versions.node
  evidence.packageManager = harness.run('pnpm', ['--version'], settings.repoRoot).trim()
  evidence.candidateRevision =
    settings.candidateRevision ??
    (settings.candidateInput ? 'unknown external archive revision' : evidence.revision)

  const createCandidate = async () => {
    if (settings.candidateInput) return resolve(settings.candidateInput)
    harness.run(
      'pnpm',
      ['--config.verify-deps-before-run=false', 'run', 'build'],
      settings.repoRoot
    )
    const packed = join(settings.tempRoot, 'candidate')
    await mkdir(packed)
    harness.run(
      'pnpm',
      ['--config.verify-deps-before-run=false', 'pack', '--pack-destination', packed],
      settings.repoRoot
    )
    const archives = await readdir(packed).then((files) =>
      files.filter((file) => file.endsWith('.tgz'))
    )
    if (archives.length !== 1)
      throw new Error('Expected one candidate archive, found ' + archives.length)
    return join(packed, archives[0])
  }

  const candidate = await createCandidate()
  evidence.candidateTarball = candidate
  evidence.candidateRevision =
    settings.candidateRevision ??
    (settings.candidateInput ? 'unknown external archive revision' : evidence.revision)
  evidence.candidateSha256 = await harness.digest(candidate)

  const [fresh, minimum, serviceOnly] = await Promise.all([
    import('./helpers/consumer/fresh.js'),
    import('./helpers/consumer/minimum.js'),
    import('./helpers/consumer/service_only.js'),
  ])
  if (settings.mode === 'fresh') {
    evidence.runs.push(
      await fresh.runFresh(candidate, 'fresh-' + settings.database + '-' + settings.compatibility)
    )
  }
  if (settings.mode === 'minimum') {
    evidence.runs.push(
      await minimum.runMinimumCompatibility(candidate, 'minimum-' + settings.database)
    )
  }
  if (settings.mode === 'service-only') {
    evidence.runs.push(
      await serviceOnly.runServiceOnly(candidate, 'service-only-' + settings.database)
    )
  }

  evidence.status = 'passed'
} catch (error) {
  failure = error
  evidence.status = 'failed'
  evidence.error = redact(errorMessage(error))
} finally {
  const collectionErrors: Error[] = []
  if (!evidencePath) {
    try {
      tempRoot ??= await mkdtemp(join(tmpdir(), 'account-kit-consumer-evidence-'))
      evidencePath = join(tempRoot, 'evidence.json')
    } catch (error) {
      collectionErrors.push(error instanceof Error ? error : new Error(String(error)))
    }
  }

  if (evidencePath) {
    try {
      await mkdir(dirname(evidencePath), { recursive: true })
    } catch (error) {
      collectionErrors.push(error instanceof Error ? error : new Error(String(error)))
    }

    if (collectionErrors.length === 0) {
      evidence.commands = commands
      evidence.logs = logs
      try {
        const commandLog = redact(
          logs.map((entry) => '$ ' + entry.command + '\n' + entry.text).join('\n')
        )
        await writeFile(join(dirname(evidencePath), 'commands.log'), commandLog + '\n')
      } catch (error) {
        collectionErrors.push(error instanceof Error ? error : new Error(String(error)))
      }
    }

    if (collectionErrors.length > 0) {
      evidence.status = 'failed'
      evidence.error = [
        evidence.error,
        ...collectionErrors.map(
          (error) => 'Evidence collection failed: ' + redact(errorMessage(error))
        ),
      ]
        .filter(Boolean)
        .join('\n')
    }

    try {
      await writeFile(evidencePath, JSON.stringify(redactedEvidence(evidence), null, 2) + '\n')
    } catch (error) {
      collectionErrors.push(error instanceof Error ? error : new Error(String(error)))
    }
  }

  if (collectionErrors.length > 0) {
    const detail = collectionErrors.map((error) => redact(errorMessage(error))).join('\n')
    console.error('Consumer evidence collection failed: ' + detail)
    if (failure) console.error('Consumer scenario also failed: ' + redact(errorMessage(failure)))
    collectionFailure = new AggregateError(
      [...(failure ? [failure] : []), ...collectionErrors],
      'Consumer evidence collection failed'
    )
  }

  if (evidencePath) {
    console.log('Consumer evidence: ' + redact(evidencePath))
    console.log('Consumer run directory: ' + redact(tempRoot ?? dirname(evidencePath)))
    console.log('Candidate revision: ' + redact(evidence.candidateRevision ?? evidence.revision))
    if (evidence.candidateSha256)
      console.log('Candidate SHA-256: ' + redact(evidence.candidateSha256))
    console.log('Status: ' + evidence.status)
  }
}

if (collectionFailure) throw new Error(redact(errorMessage(collectionFailure)))
if (failure) throw new Error(redact(errorMessage(failure)))
