import { readFile, readdir, lstat, realpath } from 'node:fs/promises'
import { join, relative as pathRelative, sep } from 'node:path'
import { safeSetupPath } from './safe_path.js'
import type { SetupChoices, SetupInspection } from './types.js'
import { parseSetupChoices } from './parse.js'

const inspectedFiles = [
  'package.json',
  'adonisrc.ts',
  'config/auth.ts',
  'config/database.ts',
  'config/mail.ts',
  'config/shield.ts',
  'config/session.ts',
  'config/account_kit.ts',
  'config/account_kit_setup.json',
  'start/routes.ts',
  'start/kernel.ts',
  'start/account_kit_routes.ts',
  'app/services/account_kit_policy.ts',
  'app/services/account_kit_notifications.ts',
  'app/services/account_kit_users.ts',
  'app/services/account_kit_guard.ts',
  'app/middleware/account_kit_access_middleware.ts',
  '.env.example',
  '.env.account-kit.example',
]

async function readOptional(root: string, relative: string): Promise<string | null> {
  const path = await safeSetupPath(root, relative)
  try {
    const stat = await lstat(path)
    if (!stat.isFile()) throw new Error(`Setup cannot inspect non-regular file ${relative}`)
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

function guardStrategies(source: string): SetupInspection['guardStrategies'] {
  const strategies: SetupInspection['guardStrategies'] = {}
  for (const match of source.matchAll(
    /(?:^|[,{\n])\s*(['"]?[\w-]+['"]?)\s*:\s*(sessionGuard|tokensGuard)\s*\(/g
  ))
    strategies[match[1].replace(/^['"]|['"]$/g, '')] =
      match[2] === 'sessionGuard' ? 'session' : 'access_tokens'
  return strategies
}

function guardModels(source: string): SetupInspection['guardModels'] {
  const models: Record<string, string> = {}
  for (const match of source.matchAll(
    /(?:^|[,{\n])\s*['"]?([\w-]+)['"]?\s*:\s*(?:sessionGuard|tokensGuard)\s*\(\s*\{[^}]*?provider\s*:\s*(?:sessionUserProvider|tokensUserProvider)\s*\(\s*\{[^}]*?model\s*:\s*\(\)\s*=>\s*import\(\s*['"]([^'"]+)['"]\s*\)/g
  ))
    models[match[1]] = match[2]
  return models
}

function databaseKind(source: string): SetupInspection['database'] {
  if (!source) return 'unknown'
  const sqlite = /(?:client\s*:\s*['"](?:better-sqlite3|sqlite3)['"]|sqlite)/i.test(source)
  const postgres = /(?:client\s*:\s*['"](?:pg|postgres)['"]|postgres)/i.test(source)
  if (sqlite && postgres) {
    const literal = source.match(/\bconnection\s*:\s*['"]([^'"]+)['"]/)?.[1]
    const selected =
      literal ??
      (/env\.get\(['"]DB_CONNECTION['"]\)/.test(source) ? process.env.DB_CONNECTION : undefined)
    if (selected === 'sqlite') return 'sqlite'
    if (selected === 'pg' || selected === 'postgres') return 'postgres'
    return 'unknown'
  }
  if (sqlite) return 'sqlite'
  if (postgres) return 'postgres'
  return 'unsupported'
}

/** Static inspection deliberately does not execute application configuration or read secret values. */
export async function inspectSetup(applicationRoot: string): Promise<SetupInspection> {
  const root = await realpath(applicationRoot)
  const files: Record<string, string> = {}
  for (const relative of inspectedFiles) {
    const value = await readOptional(root, relative)
    if (value !== null) files[relative] = value
  }
  const packageJson = JSON.parse(files['package.json'] ?? '{}') as {
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
  }
  const declaredPackages = [
    ...Object.keys(packageJson.dependencies ?? {}),
    ...Object.keys(packageJson.devDependencies ?? {}),
  ]
  const installedVersions: Record<string, string> = {}
  for (const name of declaredPackages) {
    if (!/^(?:@[\w.-]+\/)?[\w.-]+$/.test(name)) continue
    try {
      await safeSetupPath(root, `node_modules/${name}`)
      const directory = await realpath(join(root, 'node_modules', name))
      const fromRoot = pathRelative(root, directory)
      if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`)) continue
      const installed = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')) as {
        version?: string
      }
      if (typeof installed.version === 'string') installedVersions[name] = installed.version
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  const installedPackages = Object.keys(installedVersions)
  let migrationNames: string[] = []
  try {
    const migrationPath = await safeSetupPath(root, 'database/migrations')
    const migrationStat = await lstat(migrationPath)
    if (!migrationStat.isDirectory())
      throw new Error(`Setup refuses non-directory or symlink ${migrationPath}`)
    migrationNames = await readdir(migrationPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  for (const name of migrationNames.filter((filename) => filename.includes('_account_kit_'))) {
    const relative = `database/migrations/${name}`
    const value = await readOptional(root, relative)
    if (value !== null) files[relative] = value
  }
  let existingChoices: SetupChoices | null = null
  if (files['config/account_kit_setup.json']) {
    existingChoices = parseSetupChoices(JSON.parse(files['config/account_kit_setup.json']))
  }
  const existingPrefix = existingChoices?.routePrefix ?? null
  const routePaths = [
    ...(files['start/routes.ts'] ?? '').matchAll(
      /\.(?:get|post|put|patch|delete|any|prefix)\(\s*['"]([^'"]+)['"]/g
    ),
  ].map((match) => match[1])
  return {
    root,
    existingInstallation: Boolean(
      files['config/account_kit.ts'] || files['config/account_kit_setup.json']
    ),
    files,
    guards: Object.keys(guardStrategies(files['config/auth.ts'] ?? '')),
    guardStrategies: guardStrategies(files['config/auth.ts'] ?? ''),
    guardModels: guardModels(files['config/auth.ts'] ?? ''),
    database: databaseKind(files['config/database.ts'] ?? ''),
    connection: files['config/database.ts'] ? 'default' : 'unknown',
    installedPackages,
    installedVersions,
    migrationNames,
    existingPrefix,
    routePaths,
    existingChoices,
  }
}
