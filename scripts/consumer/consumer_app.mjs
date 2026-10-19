// Steps every consumer app shares: environment, archive install, configure and schema codegen fixes.
import { randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { run } from './harness.mjs'
import { ensureExclusivePostgresDatabase, pgClient } from './postgres.mjs'
import { compatibility, database, repoRoot, secret, userIdType, usersTable } from './settings.mjs'

export function databaseEnvironment(appRoot, schema = 'account_kit_consumer') {
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
    DB_CONNECTION: database === 'sqlite' ? 'sqlite' : 'postgres',
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

export async function installArchive(appRoot, archive) {
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
    const client = pgClient(appRoot, process.env.DB_DATABASE ?? 'account_kit_consumer')
    await client.connect()
    const result = await client.query('SHOW server_version')
    databaseVersion = `PostgreSQL ${result.rows[0].server_version}`
    await client.end()
  }
  return { installedPath, version: packageMetadata.version, dependencyVersions, databaseVersion }
}

export async function packageMigrations(appRoot) {
  const dir = join(appRoot, 'database/migrations')
  return (await readdir(dir))
    .filter((file) => file.includes('_account_kit_'))
    .map((file) => join(dir, file))
}

export async function configure(appRoot, env) {
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

export async function adaptGeneratedUserSchema(appRoot) {
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
