import { createRequire } from 'node:module'
import { readFile, realpath, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { run } from './harness.mjs'
import { ensureExclusivePostgresDatabase, pgClient } from './postgres.mjs'
import { compatibility, database, repoRoot } from './settings.mjs'

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
