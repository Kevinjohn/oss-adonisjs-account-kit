#!/usr/bin/env node

import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { runFresh } from './consumer/fresh.mjs'
import { commands, digest, output, redact, run } from './consumer/harness.mjs'
import { runMinimumCompatibility } from './consumer/minimum.mjs'
import { runServiceOnly } from './consumer/service_only.mjs'
import {
  baselineInput,
  baselineRevision,
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
} from './consumer/settings.mjs'
import { runUpgrade } from './consumer/upgrade.mjs'

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
  const archives = (await readdir(packed)).filter((file) => file.endsWith('.tgz'))
  if (archives.length !== 1)
    throw new Error(`Expected one candidate archive, found ${archives.length}`)
  return join(packed, archives[0])
}

const evidence = {
  revision: run('git', ['rev-parse', 'HEAD'], repoRoot).trim(),
  sourceChanges: run('git', ['status', '--short'], repoRoot).trim(),
  candidateRevision:
    candidateRevision ?? (candidateInput ? 'unknown external archive revision' : null),
  baselineRevision:
    baselineRevision ?? (baselineInput ? 'unknown external archive revision' : null),
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

  if (mode === 'fresh' || mode === 'both') {
    evidence.runs.push(await runFresh(candidate, `fresh-${database}-${compatibility}`))
  }
  if (mode === 'minimum') {
    evidence.runs.push(await runMinimumCompatibility(candidate, `minimum-${database}`))
  }
  if (mode === 'service-only') {
    evidence.runs.push(await runServiceOnly(candidate, `service-only-${database}`))
  }
  if (mode === 'upgrade' || mode === 'both') {
    const baseline = resolve(baselineInput)
    evidence.baselineTarball = baseline
    evidence.baselineSha256 = await digest(baseline)
    evidence.baselineRevision = baselineRevision ?? 'unknown external archive revision'
    evidence.runs.push(
      await runUpgrade(candidate, baseline, `upgrade-${database}-${compatibility}`)
    )
  }

  evidence.status = 'passed'
} catch (error) {
  evidence.status = 'failed'
  evidence.error = redact(error?.stack ?? error)
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
