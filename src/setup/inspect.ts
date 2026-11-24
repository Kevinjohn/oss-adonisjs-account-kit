import { realpath } from 'node:fs/promises'
import { readRegularFile } from './safe_path.js'
import type { SetupChoices, SetupInspection } from './types.js'
import { requireSetupChoices } from './parse.js'
import { inspectGuards } from './guard_inspection.js'
import { inspectDatabaseKind } from './database_inspection.js'
import { readStaticRouteDefinitions } from './route_inspection.js'
import { readInstalledPackageVersions } from './installed_packages.js'
import {
  resolveDefaultMigrationDirectory,
  inspectMigrationDirectory,
  MigrationDirectoryError,
} from './migration_paths.js'

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

/** Static inspection deliberately does not execute application configuration or read secret values. */
export async function inspectSetup(
  applicationRoot: string,
  options: {
    onInvalidSavedChoices?: (error: unknown) => void
    migrationDirectory?: string
    env?: NodeJS.ProcessEnv
  } = {}
): Promise<SetupInspection> {
  const root = await realpath(applicationRoot)
  const files: Record<string, string> = {}
  for (const relative of inspectedFiles) {
    const value = await readRegularFile(root, relative)
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
  const installedVersions = await readInstalledPackageVersions(root, declaredPackages)
  const installedPackages = Object.keys(installedVersions)
  let migrationNames: string[] = []
  let migrationDirectory: string | undefined
  let migrationDirectoryError: string | undefined
  let migrationDirectoryErrorField: string | undefined
  try {
    const directory = await inspectMigrationDirectory(
      root,
      files['config/database.ts'] ?? '',
      options.migrationDirectory,
      options.env,
      await resolveDefaultMigrationDirectory(files['adonisrc.ts'] ?? '')
    )
    migrationDirectory = directory.path
    migrationNames = directory.names
  } catch (error) {
    if (!(error instanceof MigrationDirectoryError)) throw error
    migrationDirectoryError = error.message
    migrationDirectoryErrorField = error.field
  }
  for (const name of migrationNames.filter((filename) => filename.includes('_account_kit_'))) {
    const relative = `${migrationDirectory}/${name}`
    const value = await readRegularFile(root, relative)
    if (value !== null) files[relative] = value
  }
  let existingChoices: SetupChoices | null = null
  if (files['config/account_kit_setup.json']) {
    try {
      existingChoices = requireSetupChoices(JSON.parse(files['config/account_kit_setup.json']))
    } catch (error) {
      if (!options.onInvalidSavedChoices) throw error
      options.onInvalidSavedChoices(error)
    }
  }
  const existingPrefix = existingChoices?.routePrefix ?? null
  const routeDefinitions = await readStaticRouteDefinitions(files['start/routes.ts'] ?? '')
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
    database: await inspectDatabaseKind(files['config/database.ts'] ?? '', root, options.env),
    connection: files['config/database.ts'] ? 'default' : 'unknown',
    installedPackages,
    installedVersions,
    migrationNames,
    migrationDirectory,
    migrationDirectoryError,
    migrationDirectoryErrorField,
    existingPrefix,
    routePaths,
    routeDefinitions,
    existingChoices,
  }
}
