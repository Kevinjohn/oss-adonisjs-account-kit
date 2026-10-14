#!/usr/bin/env node

import { createHash, randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import {
  cp,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const fixtureRoot = join(repoRoot, 'examples/api')
const nodeMajor = Number(process.versions.node.split('.')[0])

if (nodeMajor !== 24) {
  throw new Error(`Node 24 is required; current runtime is ${process.versions.node}`)
}

function option(name, fallback) {
  const prefix = `--${name}=`
  const arg = process.argv.find((value) => value.startsWith(prefix))
  return arg ? arg.slice(prefix.length) : fallback
}

const mode = option('mode', 'fresh')
const database = option('database', 'sqlite')
const compatibility = option('compatibility', 'latest')
const userIdType = option('user-id-type', 'integer')
const usersTable = option('users-table', 'users')
const prepareOnly = process.argv.includes('--prepare-only')
const candidateInput = option('candidate-tarball', process.env.CANDIDATE_TARBALL)
const baselineInput = option('baseline-tarball', process.env.BASELINE_TARBALL)
const candidateRevision = option('candidate-revision', process.env.CANDIDATE_REVISION)
const baselineRevision = option('baseline-revision', process.env.BASELINE_REVISION)
const supportedModes = new Set(['fresh', 'upgrade', 'both', 'minimum'])

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
  throw new Error('Baseline upgrade runs currently require the default integer users table')
}
if (['upgrade', 'both'].includes(mode) && !baselineInput) {
  throw new Error('Upgrade modes require --baseline-tarball=PATH or BASELINE_TARBALL')
}

const tempRoot = await mkdtemp(join(tmpdir(), 'account-kit-consumer-'))
const evidencePath = join(tempRoot, 'evidence.json')
const secret = process.env.DB_PASSWORD ?? ''
const output = []
const commands = []

function redact(value) {
  return secret ? String(value).split(secret).join('[REDACTED]') : String(value)
}

function run(command, args, cwd, env = process.env) {
  const record = { command, args, cwd: relative(repoRoot, cwd) || '.', exitCode: null }
  commands.push(record)
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  })
  record.exitCode = result.status ?? 1
  const text = [result.stdout, result.stderr].filter(Boolean).join('')
  if (text) output.push({ command: `${command} ${args.join(' ')}`, text: redact(text) })
  if (result.error || result.status !== 0) {
    const detail = result.error?.message ?? text.slice(-6000) ?? 'command failed'
    throw new Error(`${command} ${args.join(' ')} failed (${record.exitCode}): ${redact(detail)}`)
  }
  return result.stdout
}

async function digest(path) {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex')
}

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

function databaseEnvironment(appRoot, schema = 'account_kit_consumer') {
  const dbEnv = {
    ...process.env,
    NODE_ENV: 'test',
    TZ: 'UTC',
    LOG_LEVEL: 'silent',
    PORT: '3333',
    HOST: '127.0.0.1',
    APP_KEY: `account-kit-consumer-${randomBytes(24).toString('hex')}`,
    APP_URL: 'http://127.0.0.1:3333',
    SESSION_DRIVER: 'memory',
    LIMITER_STORE: 'memory',
    DB_CONNECTION: database === 'sqlite' ? 'sqlite' : 'pg',
  }
  if (database === 'postgres') {
    Object.assign(dbEnv, {
      DB_HOST: process.env.DB_HOST ?? '127.0.0.1',
      DB_PORT: process.env.DB_PORT ?? '55432',
      DB_USER: process.env.DB_USER ?? 'account_kit',
      DB_PASSWORD: secret,
      DB_DATABASE: process.env.DB_DATABASE ?? schema,
    })
  }
  return dbEnv
}

function setCompatibilityVersions(manifest) {
  const versions =
    compatibility === 'minimum'
      ? {
          '@adonisjs/core': '7.0.0',
          '@adonisjs/assembler': '8.0.0',
          '@adonisjs/lucid': '22.4.2',
          '@adonisjs/limiter': '3.0.0',
          'luxon': '3.0.0',
        }
      : {
          '@adonisjs/core': '^7.0.0',
          '@adonisjs/assembler': '^8.0.0',
          '@adonisjs/lucid': '^22.4.2',
          '@adonisjs/limiter': '^3.0.0',
          'luxon': '^3.0.0',
        }
  const { '@adonisjs/assembler': assembler, ...runtimeVersions } = versions
  Object.assign(manifest.dependencies, runtimeVersions)
  manifest.devDependencies['@adonisjs/assembler'] = assembler
  manifest.dependencies['better-sqlite3'] = '^12.11.1'
  manifest.dependencies.pg = '^8.23.1'
}

async function installArchive(appRoot, archive) {
  const manifestPath = join(appRoot, 'package.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  manifest.dependencies['adonisjs-account-kit'] = `file:${resolve(archive)}`
  setCompatibilityVersions(manifest)
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  run('pnpm', ['install', '--no-frozen-lockfile'], appRoot)

  const installed = join(appRoot, 'node_modules/adonisjs-account-kit')
  const installedPath = await realpath(installed)
  const appNodeModules = await realpath(join(appRoot, 'node_modules'))
  if (!installedPath.startsWith(`${appNodeModules}/`)) {
    throw new Error(`Package resolved outside the temporary consumer: ${installedPath}`)
  }
  if (installedPath.startsWith(`${repoRoot}/`)) {
    throw new Error(`Package resolved to repository source: ${installedPath}`)
  }
  const packageMetadata = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'))
  if (packageMetadata.name !== 'adonisjs-account-kit') {
    throw new Error(`Unexpected installed package name: ${packageMetadata.name}`)
  }
  const dependencyVersions = {}
  for (const name of [
    '@adonisjs/core',
    '@adonisjs/assembler',
    '@adonisjs/lucid',
    '@adonisjs/limiter',
    'luxon',
    'pg',
    'better-sqlite3',
  ]) {
    const metadata = JSON.parse(
      await readFile(join(appRoot, 'node_modules', name, 'package.json'), 'utf8')
    )
    dependencyVersions[name] = metadata.version
  }
  const require = createRequire(join(appRoot, 'package.json'))
  const Database = require('better-sqlite3')
  const sqlite = new Database(':memory:')
  const sqliteVersion = sqlite.prepare('select sqlite_version() as version').get().version
  sqlite.close()

  let databaseVersion = `SQLite ${sqliteVersion}`
  if (database === 'postgres') {
    const { Client } = require('pg')
    const client = new Client({
      host: process.env.DB_HOST ?? '127.0.0.1',
      port: Number(process.env.DB_PORT ?? '55432'),
      user: process.env.DB_USER ?? 'account_kit',
      password: secret || undefined,
      database: process.env.DB_DATABASE ?? 'account_kit_consumer',
    })
    await client.connect()
    const result = await client.query('SHOW server_version')
    databaseVersion = `PostgreSQL ${result.rows[0].server_version}`
    await client.end()
  }
  return { installedPath, version: packageMetadata.version, dependencyVersions, databaseVersion }
}

async function resetExclusivePostgresSchema(appRoot) {
  if (database !== 'postgres') return
  const databaseName = process.env.DB_DATABASE ?? 'account_kit_consumer'
  if (databaseName !== 'account_kit_consumer') {
    throw new Error(
      'PostgreSQL consumer runs only reset the dedicated account_kit_consumer database'
    )
  }
  const require = createRequire(join(appRoot, 'package.json'))
  const { Client } = require('pg')
  const client = new Client({
    host: process.env.DB_HOST ?? '127.0.0.1',
    port: Number(process.env.DB_PORT ?? '55432'),
    user: process.env.DB_USER ?? 'account_kit',
    password: secret || undefined,
    database: databaseName,
  })
  await client.connect()
  await client.query('DROP SCHEMA public CASCADE')
  await client.query('CREATE SCHEMA public')
  await client.end()
}

async function hashFiles(paths) {
  const entries = []
  for (const path of paths) entries.push([path, await digest(path)])
  return entries
}

async function packageMigrations(appRoot) {
  const dir = join(appRoot, 'database/migrations')
  return (await readdir(dir))
    .filter((file) => file.includes('_account_kit_'))
    .map((file) => join(dir, file))
}

async function configure(appRoot, env) {
  run(
    'pnpm',
    [
      'exec',
      'node',
      'ace',
      'configure',
      'adonisjs-account-kit',
      '--users-table',
      usersTable,
      '--user-id-type',
      userIdType,
    ],
    appRoot,
    env
  )
}

async function adaptGeneratedUserSchema(appRoot) {
  const schemaPath = join(appRoot, 'database/schema.ts')
  const modelPath = join(appRoot, 'app/models/user.ts')
  const schema = await readFile(schemaPath, 'utf8')
  const classes = [
    ...schema.matchAll(
      /export class (\w+Schema) extends BaseModel \{([\s\S]*?)(?=\nexport class |\n\})/g
    ),
  ]
  const userSchema = classes.find(([, , body]) => {
    const columns = body.match(/static \$columns = \[([\s\S]*?)\] as const/)?.[1] ?? ''
    return ['email', 'fullName', 'id'].every((column) =>
      new RegExp(`['"]${column}['"]`).test(columns)
    )
  })?.[1]
  if (!userSchema)
    throw new Error('Codegen did not emit a user schema with email, fullName, and id')
  const model = await readFile(modelPath, 'utf8')
  const updated = model.replace(
    /import \{ \w+Schema(?: as UserSchema)? \} from '#database\/schema'/,
    `import { ${userSchema} as UserSchema } from '#database/schema'`
  )
  if (updated === model && !model.includes(`import { ${userSchema} as UserSchema }`)) {
    throw new Error('Could not align the example model with the generated user schema')
  }
  await writeFile(modelPath, updated)
}

async function runFresh(candidate, runName) {
  const appRoot = join(tempRoot, runName)
  await cp(fixtureRoot, appRoot, {
    recursive: true,
    filter: (path) => !path.includes('/node_modules/'),
  })
  await mkdir(join(appRoot, 'tmp'), { recursive: true })
  const env = {
    ...databaseEnvironment(appRoot),
    ACCOUNT_KIT_USERS_TABLE: usersTable,
    ACCOUNT_KIT_USER_ID_TYPE: userIdType,
  }
  const adapterPath = join(tempRoot, `${runName}-adapter.ts`)
  const configPath = join(appRoot, 'config/account_kit.ts')
  const adonisrcPath = join(appRoot, 'adonisrc.ts')
  await copyFile(configPath, adapterPath)
  await rm(configPath)
  for (const migration of await packageMigrations(appRoot)) await rm(migration)
  const originalRc = await readFile(adonisrcPath, 'utf8')
  const withoutProvider = originalRc.replace(
    /^\s*\(\) => import\(['"]adonisjs-account-kit\/providers\/account_kit_provider['"]\),?\r?\n/m,
    ''
  )
  if (withoutProvider === originalRc)
    throw new Error('Fresh fixture did not contain a removable provider entry')
  await writeFile(adonisrcPath, withoutProvider)

  const installed = await installArchive(appRoot, candidate)
  await resetExclusivePostgresSchema(appRoot)
  await configure(appRoot, env)
  run('pnpm', ['exec', 'node', 'ace', 'codegen'], appRoot, env)
  await adaptGeneratedUserSchema(appRoot)
  run('pnpm', ['run', 'typecheck'], appRoot, env)
  const generatedConfigSha256 = await digest(configPath)
  const configuredRc = await readFile(adonisrcPath, 'utf8')
  if (
    (configuredRc.match(/adonisjs-account-kit\/providers\/account_kit_provider/g) ?? []).length !==
    1
  ) {
    throw new Error('Configure did not register exactly one account-kit provider')
  }
  await copyFile(adapterPath, configPath)

  const beforeConfig = await digest(configPath)
  const beforeRc = await digest(adonisrcPath)
  const beforeMigrations = await hashFiles(await packageMigrations(appRoot))
  const allMigrationFiles = await readdir(join(appRoot, 'database/migrations'))
  await configure(appRoot, env)
  if ((await digest(configPath)) !== beforeConfig)
    throw new Error('Reconfigure replaced the app-owned config')
  if ((await digest(adonisrcPath)) !== beforeRc)
    throw new Error('Reconfigure changed provider registration')
  if (
    JSON.stringify(await hashFiles(await packageMigrations(appRoot))) !==
    JSON.stringify(beforeMigrations)
  ) {
    throw new Error('Reconfigure changed an existing package migration')
  }
  if (
    JSON.stringify(await readdir(join(appRoot, 'database/migrations'))) !==
    JSON.stringify(allMigrationFiles)
  ) {
    throw new Error('Reconfigure changed the migration file set')
  }

  run('pnpm', ['exec', 'node', 'ace', 'codegen'], appRoot, env)
  await adaptGeneratedUserSchema(appRoot)
  run('pnpm', ['run', 'migrate'], appRoot, env)
  run('pnpm', ['exec', 'node', 'ace', 'codegen'], appRoot, env)
  await adaptGeneratedUserSchema(appRoot)
  run('pnpm', ['run', 'format'], appRoot, env)
  run('pnpm', ['run', 'typecheck'], appRoot, env)
  run('pnpm', ['run', 'lint'], appRoot, env)
  run('pnpm', ['run', 'format:check'], appRoot, env)
  if (!prepareOnly) run('pnpm', ['run', 'test'], appRoot, env)
  return {
    appRoot,
    installed,
    generatedConfigSha256,
    configSha256: beforeConfig,
    migrations: beforeMigrations.length,
  }
}

async function runUpgrade(candidate, baseline, runName) {
  const appRoot = join(tempRoot, runName)
  await cp(fixtureRoot, appRoot, {
    recursive: true,
    filter: (path) => !path.includes('/node_modules/'),
  })
  await mkdir(join(appRoot, 'tmp'), { recursive: true })
  const env = databaseEnvironment(appRoot)
  const configPath = join(appRoot, 'config/account_kit.ts')
  const handlerPath = join(appRoot, 'app/exceptions/handler.ts')
  await copyFile(join(appRoot, 'upgrade/baseline_account_kit.ts'), configPath)
  await copyFile(join(appRoot, 'upgrade/baseline_handler.ts'), handlerPath)
  for (const migration of await packageMigrations(appRoot)) await rm(migration)
  const baselineInstall = await installArchive(appRoot, baseline)
  await resetExclusivePostgresSchema(appRoot)
  await configure(appRoot, env)
  run('pnpm', ['exec', 'node', 'ace', 'codegen'], appRoot, env)
  await adaptGeneratedUserSchema(appRoot)
  run('pnpm', ['run', 'migrate'], appRoot, env)
  run('pnpm', ['exec', 'node', 'ace', 'codegen'], appRoot, env)
  await adaptGeneratedUserSchema(appRoot)
  run('pnpm', ['run', 'format'], appRoot, env)
  run('pnpm', ['run', 'test:upgrade-baseline'], appRoot, {
    ...env,
    ACCOUNT_KIT_UPGRADE_PHASE: 'baseline',
  })

  const configBeforeUpgrade = await digest(configPath)
  const migrationDir = join(appRoot, 'database/migrations')
  const appMigrations = (await readdir(migrationDir)).sort()
  const appMigrationHashes = await hashFiles(appMigrations.map((file) => join(migrationDir, file)))
  const candidateInstall = await installArchive(appRoot, candidate)
  await configure(appRoot, env)
  if ((await digest(configPath)) !== configBeforeUpgrade)
    throw new Error('Upgrade replaced the app-owned config')
  const upgradedMigrations = (await readdir(migrationDir)).sort()
  if (appMigrations.some((file) => !upgradedMigrations.includes(file)))
    throw new Error('Upgrade configure removed an existing application migration')
  if (
    JSON.stringify(await hashFiles(appMigrations.map((file) => join(migrationDir, file)))) !==
    JSON.stringify(appMigrationHashes)
  )
    throw new Error('Upgrade configure changed an existing application migration')
  const newlyGenerated = upgradedMigrations.filter((file) => !appMigrations.includes(file))
  if (
    newlyGenerated.length !== 1 ||
    !newlyGenerated[0].endsWith('_account_kit_create_account_transaction_lock.ts')
  ) {
    throw new Error(
      `Upgrade should add only the transaction-lock migration; added: ${newlyGenerated.join(', ')}`
    )
  }
  await copyFile(join(fixtureRoot, 'config/account_kit.ts'), configPath)
  await copyFile(join(fixtureRoot, 'app/exceptions/handler.ts'), handlerPath)
  const manuallyUpdatedConfigSha256 = await digest(configPath)
  const manuallyUpdatedHandlerSha256 = await digest(handlerPath)
  run('pnpm', ['exec', 'node', 'ace', 'codegen'], appRoot, env)
  run('pnpm', ['run', 'migrate'], appRoot, env)
  run('pnpm', ['run', 'format'], appRoot, env)
  run('pnpm', ['run', 'typecheck'], appRoot, env)
  run('pnpm', ['run', 'lint'], appRoot, env)
  run('pnpm', ['run', 'format:check'], appRoot, env)
  run('pnpm', ['run', 'test:upgrade-baseline'], appRoot, {
    ...env,
    ACCOUNT_KIT_UPGRADE_PHASE: 'candidate',
  })
  run('pnpm', ['run', 'test'], appRoot, env)
  return {
    appRoot,
    baselineInstall,
    candidateInstall,
    preservedBaselineConfigSha256: configBeforeUpgrade,
    manuallyUpdatedConfigSha256,
    manuallyUpdatedHandlerSha256,
  }
}

async function runMinimumCompatibility(candidate, runName) {
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
