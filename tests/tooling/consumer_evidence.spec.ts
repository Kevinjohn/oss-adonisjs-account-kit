import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from '@japa/runner'
import {
  collectServiceOnlyEvidence,
  optionalBackendIntegrations,
} from '../../bin/helpers/consumer/service_only.js'

const root = join(import.meta.dirname, '../..')
const frameworkPackages = [
  '@adonisjs/core',
  '@adonisjs/assembler',
  '@adonisjs/lucid',
  '@adonisjs/limiter',
  '@kevinjohn/adonisjs-account-kit',
  'luxon',
]

function appFixture(driver = 'better-sqlite3') {
  const appRoot = mkdtempSync(join(tmpdir(), 'consumer-evidence-fixture-'))
  writeFileSync(join(appRoot, 'package.json'), JSON.stringify({ name: 'consumer-fixture' }))
  for (const name of [...frameworkPackages, driver]) {
    const packageRoot = join(appRoot, 'node_modules', name)
    mkdirSync(packageRoot, { recursive: true })
    writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name, version: '1.2.3' }))
  }
  return appRoot
}

test('service-only evidence collector rejects missing or unreadable required versions', async () => {
  const appRoot = appFixture()
  const evidencePath = join(appRoot, 'service-evidence.json')
  try {
    await assert.rejects(
      collectServiceOnlyEvidence(appRoot, evidencePath, 'sqlite'),
      /runtime and database version evidence is missing or unreadable/
    )
    writeFileSync(evidencePath, '{ invalid json')
    await assert.rejects(
      collectServiceOnlyEvidence(appRoot, evidencePath, 'sqlite'),
      /runtime and database version evidence is missing or unreadable/
    )
    writeFileSync(evidencePath, JSON.stringify({ runtime: process.versions.node }))
    await assert.rejects(
      collectServiceOnlyEvidence(appRoot, evidencePath, 'sqlite'),
      /runtime and database version evidence is incomplete/
    )
    writeFileSync(
      evidencePath,
      JSON.stringify({ runtime: process.versions.node, databaseVersion: 'SQLite 3.45.0' })
    )
    const packagePath = join(appRoot, 'node_modules', '@adonisjs/core', 'package.json')
    unlinkSync(packagePath)
    await assert.rejects(
      collectServiceOnlyEvidence(appRoot, evidencePath, 'sqlite'),
      /package version evidence is missing or unreadable: @adonisjs\/core/
    )
    writeFileSync(packagePath, '{ invalid json')
    await assert.rejects(
      collectServiceOnlyEvidence(appRoot, evidencePath, 'sqlite'),
      /package version evidence is missing or unreadable: @adonisjs\/core/
    )
  } finally {
    rmSync(appRoot, { recursive: true, force: true })
  }
})

test('service-only versions come from the app and optional integrations remain absent', async () => {
  const appRoot = appFixture()
  const evidencePath = join(appRoot, 'service-evidence.json')
  writeFileSync(
    evidencePath,
    JSON.stringify({ runtime: process.versions.node, databaseVersion: 'SQLite 3.45.0' })
  )
  try {
    const evidence = await collectServiceOnlyEvidence(appRoot, evidencePath, 'sqlite')
    assert.equal(evidence.runtime, process.versions.node)
    assert.equal(evidence.databaseVersion, 'SQLite 3.45.0')
    assert.deepEqual(
      evidence.dependencyVersions,
      Object.fromEntries([...frameworkPackages, 'better-sqlite3'].map((name) => [name, '1.2.3']))
    )
    assert.deepEqual(evidence.absentDependencies, optionalBackendIntegrations)
    for (const name of optionalBackendIntegrations)
      assert.equal(existsSync(join(appRoot, 'node_modules', name)), false)
  } finally {
    rmSync(appRoot, { recursive: true, force: true })
  }
})

test('service-only evidence selects the PostgreSQL driver and server version', async () => {
  const appRoot = appFixture('pg')
  const evidencePath = join(appRoot, 'service-evidence.json')
  writeFileSync(
    evidencePath,
    JSON.stringify({ runtime: process.versions.node, databaseVersion: 'PostgreSQL 16.5' })
  )
  try {
    const evidence = await collectServiceOnlyEvidence(appRoot, evidencePath, 'postgres')
    assert.equal(evidence.databaseVersion, 'PostgreSQL 16.5')
    assert.deepEqual(
      evidence.dependencyVersions,
      Object.fromEntries([...frameworkPackages, 'pg'].map((name) => [name, '1.2.3']))
    )
    assert.deepEqual(evidence.absentDependencies, optionalBackendIntegrations)
  } finally {
    rmSync(appRoot, { recursive: true, force: true })
  }
})

test('a failure before settings initialize writes a failed incomplete evidence record', () => {
  const directory = mkdtempSync(join(tmpdir(), 'consumer-evidence-output-'))
  const evidencePath = join(directory, 'nested', 'evidence.json')
  try {
    const result = spawnSync(
      process.execPath,
      [
        '--import=@poppinss/ts-exec',
        '--enable-source-maps',
        join(root, 'bin/test_consumer.ts'),
        '--mode=unknown',
      ],
      {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, CONSUMER_EVIDENCE_PATH: evidencePath },
      }
    )
    assert.notEqual(result.status, 0, result.stdout + result.stderr)
    assert.equal(result.error, undefined)
    assert.match(result.stderr, /Unknown mode: unknown/)
    const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'))
    assert.equal(evidence.status, 'failed')
    assert.equal(evidence.mode, 'unknown')
    assert.match(evidence.error, /Unknown mode: unknown/)
    assert.equal(evidence.revision, 'unavailable')
    assert.equal(evidence.packageManager, 'unavailable')
    assert.equal('candidateSha256' in evidence, false)
    assert.equal(existsSync(join(directory, 'nested', 'commands.log')), true)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('a candidate evidence failure writes a failed record with collected source metadata', () => {
  const directory = mkdtempSync(join(tmpdir(), 'consumer-evidence-candidate-'))
  const evidencePath = join(directory, 'evidence.json')
  try {
    const result = spawnSync(
      process.execPath,
      [
        '--import=@poppinss/ts-exec',
        '--enable-source-maps',
        join(root, 'bin/test_consumer.ts'),
        '--candidate-tarball=' + join(directory, 'missing.tgz'),
        '--candidate-revision=controlled-fixture-revision',
      ],
      {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, CONSUMER_EVIDENCE_PATH: evidencePath },
      }
    )
    assert.notEqual(result.status, 0, result.stdout + result.stderr)
    assert.equal(result.error, undefined)
    const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'))
    assert.equal(evidence.status, 'failed')
    assert.notEqual(evidence.revision, 'unavailable')
    assert.notEqual(evidence.packageManager, 'unavailable')
    assert.equal(evidence.candidateRevision, 'controlled-fixture-revision')
    assert.equal('candidateSha256' in evidence, false)
    assert.match(evidence.error, /missing\.tgz/)
    assert.match(readFileSync(join(directory, 'commands.log'), 'utf8'), /pnpm --version/)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
