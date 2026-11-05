import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  chmodSync,
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
import * as ts from 'typescript'
import {
  collectServiceOnlyEvidence,
  generateServiceSource,
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

test('generated service source parses for SQLite and PostgreSQL', ({ assert: japaAssert }) => {
  for (const database of ['sqlite', 'postgres'] as const) {
    const result = ts.transpileModule(generateServiceSource(database), {
      fileName: 'service.ts',
      compilerOptions: {
        module: ts.ModuleKind.NodeNext,
        target: ts.ScriptTarget.ES2022,
      },
      reportDiagnostics: true,
    })
    const errors = (result.diagnostics ?? []).filter(
      (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error
    )
    japaAssert.deepEqual(
      errors.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')),
      [],
      `${database} service source should have no TypeScript syntax diagnostics`
    )
  }
})

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
        '--candidate-revision=cli-revision',
      ],
      {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          TMPDIR: directory,
          CONSUMER_EVIDENCE_PATH: evidencePath,
          CANDIDATE_REVISION: 'environment-revision',
        },
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
    assert.equal(evidence.candidateRevision, 'cli-revision')
    assert.equal('candidateSha256' in evidence, false)
    assert.equal(existsSync(join(directory, 'nested', 'commands.log')), true)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('final candidate evidence redacts secret metadata without changing its JSON types', () => {
  const directory = mkdtempSync(join(tmpdir(), 'consumer-evidence-redaction-'))
  const evidencePath = join(directory, 'evidence.json')
  const secret = 'fictional-db-password-marker'
  const candidatePath = join(directory, `missing-${secret}.tgz`)
  const candidateRevision = `revision-${secret}`
  const commandDirectory = join(directory, 'bin')
  const pnpmPath = join(commandDirectory, 'pnpm')
  mkdirSync(commandDirectory)
  writeFileSync(pnpmPath, `#!/bin/sh\nprintf '%s\\n' '${secret}'\n`)
  chmodSync(pnpmPath, 0o755)
  try {
    const result = spawnSync(
      process.execPath,
      [
        '--import=@poppinss/ts-exec',
        '--enable-source-maps',
        join(root, 'bin/test_consumer.ts'),
        '--candidate-tarball=' + candidatePath,
        '--candidate-revision=' + candidateRevision,
      ],
      {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          TMPDIR: directory,
          DB_PASSWORD: secret,
          CONSUMER_EVIDENCE_PATH: evidencePath,
          PATH: `${commandDirectory}:${process.env.PATH ?? ''}`,
        },
      }
    )
    assert.notEqual(result.status, 0, result.stdout + result.stderr)
    assert.equal(result.error, undefined)
    const serialized = readFileSync(evidencePath, 'utf8')
    const evidence = JSON.parse(serialized)
    const commandLog = readFileSync(join(directory, 'commands.log'), 'utf8')
    assert.equal(evidence.status, 'failed')
    assert.equal(typeof evidence.candidateTarball, 'string')
    assert.equal(evidence.candidateTarball.includes('[REDACTED]'), true)
    assert.equal(evidence.candidateRevision, `revision-[REDACTED]`)
    assert.equal(evidence.packageManager, '[REDACTED]')
    assert.equal(typeof evidence.commands, 'object')
    assert.equal(Array.isArray(evidence.commands), true)
    assert.equal(typeof evidence.runs, 'object')
    assert.equal(Array.isArray(evidence.runs), true)
    assert.equal(typeof evidence.prepareOnly, 'boolean')
    assert.equal(typeof evidence.error, 'string')
    assert.equal(serialized.includes(secret), false)
    assert.equal(commandLog.includes(secret), false)
    assert.equal(commandLog.includes('[REDACTED]'), true)
    assert.equal((result.stdout + result.stderr).includes(secret), false)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('redaction preserves evidence keys and tool-owned values', () => {
  const expectedKeys = [
    'candidateRevision',
    'commands',
    'compatibility',
    'database',
    'error',
    'logs',
    'mode',
    'packageManager',
    'prepareOnly',
    'revision',
    'runs',
    'runtime',
    'sourceChanges',
    'status',
    'userIdType',
    'usersTable',
  ]
  for (const password of ['status', 'failed', 'sqlite']) {
    const directory = mkdtempSync(join(tmpdir(), 'consumer-evidence-schema-'))
    const evidencePath = join(directory, 'evidence.json')
    try {
      const result = spawnSync(
        process.execPath,
        [
          '--import=@poppinss/ts-exec',
          '--enable-source-maps',
          join(root, 'bin/test_consumer.ts'),
          '--mode=unknown',
          '--candidate-revision=' + password,
        ],
        {
          cwd: root,
          encoding: 'utf8',
          env: {
            ...process.env,
            TMPDIR: directory,
            DB_PASSWORD: password,
            CONSUMER_EVIDENCE_PATH: evidencePath,
          },
        }
      )
      assert.notEqual(result.status, 0, result.stdout + result.stderr)
      assert.equal(result.error, undefined)
      const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'))
      assert.deepEqual(Object.keys(evidence).sort(), expectedKeys)
      assert.equal(evidence.status, 'failed')
      assert.equal(evidence.database, 'sqlite')
      assert.equal(evidence.candidateRevision, '[REDACTED]')
      assert.match(result.stdout, /Candidate revision: \[REDACTED\]/)
      assert.match(result.stdout, /Status: failed/)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
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
        env: { ...process.env, TMPDIR: directory, CONSUMER_EVIDENCE_PATH: evidencePath },
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
