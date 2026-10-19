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
import { format, resolveConfig } from 'prettier'

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
const candidateRevision = option('candidate-revision', process.env.CANDIDATE_REVISION)
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

function expectFailure(command, args, cwd, env, expected) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  })
  const outputText = [result.stdout, result.stderr].filter(Boolean).join('')
  commands.push({
    command,
    args,
    cwd: relative(repoRoot, cwd) || '.',
    exitCode: result.status ?? 1,
  })
  if (result.error || result.status === 0 || !outputText.includes(expected)) {
    throw new Error(`Expected ${command} ${args.join(' ')} to reject: ${expected}`)
  }
  output.push({
    command: `${command} ${args.join(' ')} (expected rejection)`,
    text: redact(outputText),
  })
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
  await ensureExclusivePostgresDatabase(appRoot)

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

async function ensureExclusivePostgresDatabase(appRoot) {
  if (database !== 'postgres') return
  const databaseName = process.env.DB_DATABASE ?? 'account_kit_consumer'
  if (databaseName !== 'account_kit_consumer') {
    throw new Error('PostgreSQL consumer runs require the dedicated account_kit_consumer database')
  }
  const require = createRequire(join(appRoot, 'package.json'))
  const { Client } = require('pg')
  const client = new Client({
    host: process.env.DB_HOST ?? '127.0.0.1',
    port: Number(process.env.DB_PORT ?? '55432'),
    user: process.env.DB_USER ?? 'account_kit',
    password: secret || undefined,
    database: 'postgres',
  })
  await client.connect()
  try {
    const existing = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [
      databaseName,
    ])
    if (existing.rowCount === 0) await client.query('CREATE DATABASE account_kit_consumer')
  } finally {
    await client.end()
  }
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

/** Checks the generated config as written, before the app's formatter can repair it. */
async function checkGeneratedStyle(appRoot, env) {
  const configPath = join(appRoot, 'config/account_kit.ts')
  // The AdonisJS stub engine trims every file it renders, so the final newline is not ours.
  const generated = await readFile(configPath, 'utf8')
  const written = generated + '\n'
  const options = await resolveConfig(configPath)
  if ((await format(written, { ...options, filepath: configPath })) !== written)
    throw new Error('The generated config/account_kit.ts is not formatted')
  await writeFile(configPath, written)
  try {
    run('pnpm', ['exec', 'eslint', '--max-warnings', '0', 'config/account_kit.ts'], appRoot, env)
  } finally {
    await writeFile(configPath, generated)
  }
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
  await checkGeneratedStyle(appRoot, env)
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
  if (!prepareOnly) {
    run('pnpm', ['run', 'test'], appRoot, { ...env, ACCOUNT_KIT_AUTH_STRATEGY: 'access_tokens' })
    run('pnpm', ['run', 'test:session'], appRoot, {
      ...env,
      ACCOUNT_KIT_AUTH_STRATEGY: 'session',
      SESSION_DRIVER: 'memory',
    })
    run(
      'pnpm',
      ['exec', 'node', 'ace', 'test', '--files=tests/functional/release_scenarios.spec.ts'],
      appRoot,
      { ...env, ACCOUNT_KIT_AUTH_STRATEGY: 'session', SESSION_DRIVER: 'memory' }
    )
    expectFailure(
      'pnpm',
      ['run', 'test:session'],
      appRoot,
      { ...env, ACCOUNT_KIT_AUTH_STRATEGY: 'session', SESSION_DRIVER: 'cookie' },
      'session authentication requires a server-side session store'
    )
  }
  return {
    appRoot,
    installed,
    generatedConfigSha256,
    configSha256: beforeConfig,
    migrations: beforeMigrations.length,
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

async function runServiceOnly(candidate, runName) {
  const appRoot = join(tempRoot, runName)
  await mkdir(appRoot)
  const manifest = {
    name: 'account-kit-service-only-consumer',
    private: true,
    type: 'module',
    dependencies: {
      '@adonisjs/core': '^7.0.0',
      '@adonisjs/lucid': '^22.4.2',
      '@adonisjs/limiter': '^3.0.0',
      'adonisjs-account-kit': `file:${resolve(candidate)}`,
      'luxon': '^3.0.0',
      [database === 'sqlite' ? 'better-sqlite3' : 'pg']:
        database === 'sqlite' ? '^12.11.1' : '^8.23.1',
    },
    scripts: { build: 'tsc', start: 'node build/service.js' },
    devDependencies: {
      '@adonisjs/assembler': '^8.0.0',
      '@adonisjs/redis': '^10.0.0',
      '@types/json-schema': '^7.0.15',
      '@types/luxon': '^3.7.5',
      '@types/node': '^24.10.0',
      '@types/picomatch': '^4.0.0',
      '@types/yargs-parser': '^21.0.3',
      '@vinejs/vine': '^4.0.0',
      'json-schema': '^0.4.0',
      'typescript': '~6.0.3',
    },
  }
  await writeFile(join(appRoot, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  await writeFile(join(appRoot, 'pnpm-workspace.yaml'), 'allowBuilds:\n  better-sqlite3: true\n')
  await writeFile(
    join(appRoot, 'tsconfig.json'),
    `${JSON.stringify({ compilerOptions: { module: 'NodeNext', moduleResolution: 'NodeNext', target: 'ES2022', strict: true, skipLibCheck: false, outDir: 'build' }, files: ['service.ts'] }, null, 2)}\n`
  )
  await writeFile(
    join(appRoot, 'service.ts'),
    `import { createRequire } from 'node:module'
import { IgnitorFactory } from '@adonisjs/core/factories'
import { defineConfig as defineDatabaseConfig } from '@adonisjs/lucid'
import { defineConfig as defineLimiterConfig, stores } from '@adonisjs/limiter'
import { AccountKit, defineConfig, type UsersAdapter } from 'adonisjs-account-kit'

const require = createRequire(import.meta.url)
for (const name of ['@adonisjs/auth', '@adonisjs/session', '@adonisjs/shield', '@tuyau/core', '@adonisjs/mail', '@adonisjs/ally']) {
  try { require.resolve(name); throw new Error('Backend-only dependency installed: ' + name) }
  catch (error) { if ((error as { code?: string }).code !== 'MODULE_NOT_FOUND') throw error }
}
const connection = ${
      database === 'sqlite'
        ? `{ client: 'better-sqlite3' as const, connection: { filename: './service.sqlite' }, useNullAsDefault: true }`
        : `{ client: 'pg' as const, connection: { host: process.env.DB_HOST ?? '127.0.0.1', port: Number(process.env.DB_PORT ?? '55432'), user: process.env.DB_USER ?? 'account_kit', password: process.env.DB_PASSWORD ?? '', database: process.env.DB_DATABASE ?? 'account_kit_consumer' } }`
    }
const ignitor = new IgnitorFactory().withCoreProviders().withCoreConfig().merge({
  rcFileContents: { providers: [
    () => import('@adonisjs/lucid/database_provider'),
    () => import('@adonisjs/limiter/limiter_provider'),
    () => import('adonisjs-account-kit/providers/account_kit_provider'),
  ] },
  config: {
    database: defineDatabaseConfig({ connection: 'service', connections: { service: connection } }),
    limiter: defineLimiterConfig({ default: 'memory', stores: { memory: stores.memory({}) } }),
  },
}).create(new URL('../', import.meta.url))
const app = ignitor.createApp('console')
try {
  await app.init()
  await app.boot()
  const db = await app.container.make('lucid.db')
  const result = await db.connection().rawQuery('select 1 as value').exec()
  if (!result) throw new Error('Database did not start')
  const users = {
    findById: async () => ({ id: 1, email: 'active@example.test', unverifiedEmail: null, hasPassword: false, emailVerifiedAt: null }),
    markEmailVerified: async () => {},
    setPassword: async () => {},
  } as unknown as UsersAdapter
  app.config.set('account_kit', defineConfig({
    enabled: ['emailVerification'],
    registration: { availability: 'open' },
    limiterSecret: 'service_only_consumer_secret_32_bytes',
    users,
    urls: { emailVerification: (token) => 'https://example.test/activate/' + token },
    notify: { accountActivationProvision: async () => {} },
  }))
  const service: AccountKit = await app.container.make(AccountKit)
  if (await service.emailVerification.send({ userId: 1 }) !== 'already_verified') throw new Error('Service did not boot')
  console.log('Compiled service-only startup passed; backend-only dependencies absent')
} finally {
  await ignitor.terminate()
}
`
  )
  run('pnpm', ['install', '--no-frozen-lockfile'], appRoot)
  const installed = await realpath(join(appRoot, 'node_modules/adonisjs-account-kit'))
  if (!installed.startsWith(`${await realpath(join(appRoot, 'node_modules'))}/`)) {
    throw new Error('Service-only package resolved outside isolated consumer')
  }
  run('pnpm', ['run', 'build'], appRoot)
  run('pnpm', ['run', 'start'], appRoot, databaseEnvironment(appRoot))
  return {
    appRoot,
    installed,
    scenario: 'isolated service-only compile and startup without backend-only dependencies',
    absentDependencies: [
      '@adonisjs/auth',
      '@adonisjs/session',
      '@adonisjs/shield',
      '@tuyau/core',
      '@adonisjs/mail',
      '@adonisjs/ally',
    ],
  }
}

const evidence = {
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
