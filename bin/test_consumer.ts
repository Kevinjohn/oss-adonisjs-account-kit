#!/usr/bin/env node

import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { runFresh } from './helpers/consumer/fresh.js'
import { commands, digest, output, redact, run } from './helpers/consumer/harness.js'
import { runMinimumCompatibility } from './helpers/consumer/minimum.js'
import { runServiceOnly } from './helpers/consumer/service_only.js'
import {
  candidateInput,
  candidateRevision,
  compatibility,
  database,
  mode,
  prepareOnly,
  repoRoot,
  tempRoot,
  userIdType,
  usersTable,
} from './helpers/consumer/settings.js'

const evidencePath = join(tempRoot, 'evidence.json')

async function createCandidate() {
  if (candidateInput) return resolve(candidateInput)
  run('pnpm', ['--config.verify-deps-before-run=false', 'run', 'build'], repoRoot)
  const packed = join(tempRoot, 'candidate')
  await mkdir(packed)
  run(
    'pnpm',
    ['--config.verify-deps-before-run=false', 'pack', '--pack-destination', packed],
    repoRoot
  )
  const archives = await readdir(packed).then((files) =>
    files.filter((file) => file.endsWith('.tgz'))
  )
  if (archives.length !== 1)
    throw new Error(`Expected one candidate archive, found ${archives.length}`)
  return join(packed, archives[0])
}

const evidence: {
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
  commands: typeof commands
  runs: unknown[]
  status: string
  candidateTarball?: string
  candidateSha256?: string
  error?: string
  logs?: typeof output
} = {
  revision: run('git', ['rev-parse', 'HEAD'], repoRoot).trim(),
  sourceChanges: run('git', ['status', '--short'], repoRoot).trim(),
  candidateRevision:
    candidateRevision ?? (candidateInput ? 'unknown external archive revision' : null),
  runtime: process.versions.node,
  packageManager: run('pnpm', ['--version'], repoRoot).trim(),
  database,
  compatibility,
  userIdType,
  usersTable,
  prepareOnly,
  mode,
  commands,
  runs: [],
  status: 'running',
}

try {
  const candidate = await createCandidate()
  evidence.candidateTarball = candidate
  evidence.candidateRevision =
    candidateRevision ?? (candidateInput ? 'unknown external archive revision' : evidence.revision)
  evidence.candidateSha256 = await digest(candidate)

  if (mode === 'fresh') {
    evidence.runs.push(await runFresh(candidate, `fresh-${database}-${compatibility}`))
  }
  if (mode === 'minimum') {
    evidence.runs.push(await runMinimumCompatibility(candidate, `minimum-${database}`))
  }
  if (mode === 'service-only') {
    evidence.runs.push(await runServiceOnly(candidate, `service-only-${database}`))
  }

  evidence.status = 'passed'
} catch (error) {
  evidence.status = 'failed'
  evidence.error = redact(error instanceof Error ? (error.stack ?? error.message) : error)
  throw error
} finally {
  evidence.commands = commands
  evidence.logs = output
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`)
  console.log(`Consumer evidence: ${evidencePath}`)
  console.log(`Consumer run directory: ${tempRoot}`)
  console.log(`Candidate revision: ${evidence.candidateRevision ?? evidence.revision}`)
  if (evidence.candidateSha256) console.log(`Candidate SHA-256: ${evidence.candidateSha256}`)
  console.log(`Status: ${evidence.status}`)
}
