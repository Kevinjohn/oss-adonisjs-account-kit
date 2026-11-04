// Service only: compile and boot the package without the backend-only dependencies installed.
import { createRequire } from 'node:module'
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { databaseEnvironment } from './consumer_app.js'
import { run } from './harness.js'
import { database, tempRoot } from './settings.js'

export const optionalBackendIntegrations = [
  '@adonisjs/auth',
  '@adonisjs/session',
  '@adonisjs/shield',
  '@tuyau/core',
  '@adonisjs/mail',
  '@adonisjs/ally',
]

const frameworkPackages = [
  '@adonisjs/core',
  '@adonisjs/assembler',
  '@adonisjs/lucid',
  '@adonisjs/limiter',
  '@kevinjohn/adonisjs-account-kit',
  'luxon',
]

interface ServiceRuntimeEvidence {
  runtime: string
  databaseVersion: string
}

async function installedVersion(appRoot: string, name: string): Promise<string> {
  let metadata: { name?: unknown; version?: unknown }
  try {
    metadata = JSON.parse(
      await readFile(join(appRoot, 'node_modules', name, 'package.json'), 'utf8')
    )
  } catch (error) {
    throw new Error(
      `Required service-only package version evidence is missing or unreadable: ${name}`,
      {
        cause: error,
      }
    )
  }
  if (metadata.name !== name || typeof metadata.version !== 'string' || !metadata.version) {
    throw new Error(`Required service-only package version evidence is invalid: ${name}`)
  }
  return metadata.version
}

export async function collectServiceOnlyEvidence(
  appRoot: string,
  evidencePath: string,
  selectedDatabase: string
) {
  if (selectedDatabase !== 'sqlite' && selectedDatabase !== 'postgres') {
    throw new Error(`Unknown service-only database: ${selectedDatabase}`)
  }

  let runtimeEvidence: ServiceRuntimeEvidence
  try {
    runtimeEvidence = JSON.parse(await readFile(evidencePath, 'utf8'))
  } catch (error) {
    throw new Error(
      'Required service-only runtime and database version evidence is missing or unreadable',
      {
        cause: error,
      }
    )
  }
  const databasePrefix = selectedDatabase === 'sqlite' ? 'SQLite ' : 'PostgreSQL '
  if (
    typeof runtimeEvidence.runtime !== 'string' ||
    !/^24\./.test(runtimeEvidence.runtime) ||
    typeof runtimeEvidence.databaseVersion !== 'string' ||
    !runtimeEvidence.databaseVersion.startsWith(databasePrefix) ||
    runtimeEvidence.databaseVersion.length === databasePrefix.length
  ) {
    throw new Error('Required service-only runtime and database version evidence is incomplete')
  }

  const dependencyVersions: Record<string, string> = {}
  const driver = selectedDatabase === 'sqlite' ? 'better-sqlite3' : 'pg'
  for (const name of [...frameworkPackages, driver]) {
    dependencyVersions[name] = await installedVersion(appRoot, name)
  }

  const require = createRequire(join(appRoot, 'package.json'))
  const absentDependencies: string[] = []
  for (const name of optionalBackendIntegrations) {
    try {
      const resolved = require.resolve(name)
      throw new Error(`Optional backend integration ${name} is installed: ${resolved}`)
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'MODULE_NOT_FOUND') {
        absentDependencies.push(name)
        continue
      }
      throw error
    }
  }

  return {
    runtime: runtimeEvidence.runtime,
    dependencyVersions,
    databaseVersion: runtimeEvidence.databaseVersion,
    absentDependencies,
  }
}

export function generateServiceSource(selectedDatabase: string) {
  if (selectedDatabase !== 'sqlite' && selectedDatabase !== 'postgres') {
    throw new Error(`Unknown service-only database: ${selectedDatabase}`)
  }
  const connection =
    selectedDatabase === 'sqlite'
      ? `{ client: 'better-sqlite3' as const, connection: { filename: './service.sqlite' }, useNullAsDefault: true }`
      : `{ client: 'pg' as const, connection: { host: process.env.DB_HOST ?? '127.0.0.1', port: Number(process.env.DB_PORT ?? '55432'), user: process.env.DB_USER ?? 'account_kit', password: process.env.DB_PASSWORD ?? '', database: process.env.DB_DATABASE ?? 'account_kit_consumer' } }`
  return `import { createRequire } from 'node:module'
import { writeFile } from 'node:fs/promises'
import { IgnitorFactory } from '@adonisjs/core/factories'
import { defineConfig as defineDatabaseConfig } from '@adonisjs/lucid'
import { defineConfig as defineLimiterConfig, stores } from '@adonisjs/limiter'
import { AccountKit, defineConfig, type UsersAdapter } from '@kevinjohn/adonisjs-account-kit'
import type { AccountAccessInput, AccountAccessSnapshot } from '@kevinjohn/adonisjs-account-kit/types'
import { AccountAccessDeniedError, InvalidInputError } from '@kevinjohn/adonisjs-account-kit/errors'

const require = createRequire(import.meta.url)
for (const name of ${JSON.stringify(optionalBackendIntegrations)}) {
  try { require.resolve(name); throw new Error('Backend-only dependency installed: ' + name) }
  catch (error) { if ((error as { code? }).code !== 'MODULE_NOT_FOUND') throw error }
}
const connection = ${connection}
const ignitor = new IgnitorFactory().withCoreProviders().withCoreConfig().merge({
  rcFileContents: { providers: [
    () => import('@adonisjs/lucid/database_provider'),
    () => import('@adonisjs/limiter/limiter_provider'),
    () => import('@kevinjohn/adonisjs-account-kit/account_kit_provider'),
  ] },
  config: {
    database: defineDatabaseConfig({ connection: 'service', connections: { service: connection } }),
    limiter: defineLimiterConfig({ default: 'memory', stores: { memory: stores.memory({}) } }),
  },
}).create(new URL('../../../', import.meta.url))
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
    authentication: { strategy: 'session', guard: 'web' },
    urls: { emailVerification: (token) => 'https://example.test/activate/' + token },
    notify: { accountActivationProvision: async () => {} },
  }))
  const service: AccountKit = await app.container.make(AccountKit)
  if (await service.emailVerification.send({ userId: 1 }) !== 'already_verified') throw new Error('Service did not boot')
  const inspect: (input: AccountAccessInput) => Promise<AccountAccessSnapshot> =
    (input) => service.authentication.inspectAccountAccess(input)
  if (AccountAccessDeniedError.code !== 'E_ACCOUNT_KIT_ACCOUNT_ACCESS_DENIED') throw new Error('Denial export missing')
  try { await inspect({ userId: '', requireActive: true }); throw new Error('Inspection accepted invalid input') }
  catch (error) { if (!(error instanceof InvalidInputError)) throw error }
  let databaseVersion: string
  if (${JSON.stringify(selectedDatabase)} === 'sqlite') {
    const Database = require('better-sqlite3')
    const sqlite = new Database('./service.sqlite')
    try {
      const result = sqlite.prepare('select sqlite_version() as version').get()
      if (!result?.version) throw new Error('Could not read the SQLite server version')
      databaseVersion = 'SQLite ' + result.version
    } finally { sqlite.close() }
  } else {
    const { Client } = require('pg')
    const client = new Client({
      host: process.env.DB_HOST ?? '127.0.0.1',
      port: Number(process.env.DB_PORT ?? '55432'),
      user: process.env.DB_USER ?? 'account_kit',
      password: process.env.DB_PASSWORD ?? '',
      database: process.env.DB_DATABASE ?? 'account_kit_consumer',
    })
    await client.connect()
    try {
      const result = await client.query('SHOW server_version')
      if (!result.rows[0]?.server_version) throw new Error('Could not read the PostgreSQL server version')
      databaseVersion = 'PostgreSQL ' + result.rows[0].server_version
    } finally { await client.end() }
  }
  const versionEvidencePath = process.env.ACCOUNT_KIT_SERVICE_EVIDENCE_PATH
  if (!versionEvidencePath) throw new Error('Service-only version evidence path is missing')
  await writeFile(versionEvidencePath, JSON.stringify({ runtime: process.versions.node, databaseVersion }, null, 2) + '\\n')
  console.log('Compiled service-only startup passed; backend-only dependencies absent')
} finally {
  await ignitor.terminate()
}
`
}

export async function runServiceOnly(candidate: string, runName: string) {
  const appRoot = join(tempRoot, runName)
  const serviceEvidencePath = join(appRoot, 'service-evidence.json')
  await mkdir(appRoot)
  const manifest = {
    name: 'account-kit-service-only-consumer',
    private: true,
    type: 'module',
    dependencies: {
      '@adonisjs/core': '^7.0.0',
      '@adonisjs/lucid': '^22.4.2',
      '@adonisjs/limiter': '^3.0.0',
      '@kevinjohn/adonisjs-account-kit': `file:${resolve(candidate)}`,
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
  await writeFile(join(appRoot, 'service.ts'), generateServiceSource(database))
  run('pnpm', ['install', '--no-frozen-lockfile'], appRoot)
  const installed = await realpath(join(appRoot, 'node_modules/@kevinjohn/adonisjs-account-kit'))
  if (!installed.startsWith(`${await realpath(join(appRoot, 'node_modules'))}/`)) {
    throw new Error('Service-only package resolved outside isolated consumer')
  }
  run('pnpm', ['run', 'build'], appRoot)
  run('pnpm', ['run', 'start'], appRoot, {
    ...databaseEnvironment(appRoot),
    ACCOUNT_KIT_SERVICE_EVIDENCE_PATH: serviceEvidencePath,
  })
  const serviceEvidence = await collectServiceOnlyEvidence(appRoot, serviceEvidencePath, database)
  return {
    appRoot,
    installed,
    scenario: 'isolated service-only compile and startup without backend-only dependencies',
    ...serviceEvidence,
  }
}
