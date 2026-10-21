// Service only: compile and boot the package without the backend-only dependencies installed.
import { mkdir, realpath, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { databaseEnvironment } from './consumer_app.mjs'
import { run } from './harness.mjs'
import { database, tempRoot } from './settings.mjs'

export async function runServiceOnly(candidate, runName) {
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
import type { AccountAccessInput, AccountAccessSnapshot } from 'adonisjs-account-kit/types'
import { AccountAccessDeniedError, InvalidInputError } from 'adonisjs-account-kit/errors'

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
