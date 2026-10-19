import { readFile, readdir, lstat, realpath } from 'node:fs/promises'
import { safeSetupPath } from './safe_path.js'
import type { SetupChoices, SetupInspection } from './types.js'
import { parseSetupChoices } from './parse.js'
import { inspectGuards } from './guard_inspection.js'
import { databaseKind } from './database_inspection.js'
import { staticRouteDefinitions } from './route_inspection.js'
import { installedPackageVersions } from './installed_packages.js'

const inspectedFiles = [
  'package.json',
  'adonisrc.ts',
  'config/auth.ts',
  'config/database.ts',
  'config/limiter.ts',
  'config/mail.ts',
  'config/ally.ts',
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
  'app/middleware/account_kit_proof_headers_middleware.ts',
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
  const installedVersions = await installedPackageVersions(root, declaredPackages)
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
  const routeDefinitions = await staticRouteDefinitions(files['start/routes.ts'] ?? '')
  const routePaths = routeDefinitions.map(({ path }) => path)
  const { strategies, models, tokenProviders } = await inspectGuards(files['config/auth.ts'] ?? '')
  return {
    root,
    existingInstallation: Boolean(
      files['config/account_kit.ts'] || files['config/account_kit_setup.json']
    ),
    files,
    guards: Object.keys(strategies),
    guardStrategies: strategies,
    guardModels: models,
    guardTokenProviders: tokenProviders,
    database: await databaseKind(files['config/database.ts'] ?? '', root),
    connection: files['config/database.ts'] ? 'default' : 'unknown',
    installedPackages,
    installedVersions,
    migrationNames,
    existingPrefix,
    routePaths,
    routeDefinitions,
    existingChoices,
  }
}
