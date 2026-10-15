import { readFile, readdir, lstat, realpath } from 'node:fs/promises'
import { join } from 'node:path'
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
  const path = join(root, relative)
  try {
    const stat = await lstat(path)
    if (!stat.isFile()) throw new Error(`Setup cannot inspect non-regular file ${relative}`)
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

function existingGuards(source: string): string[] {
  const match = source.match(/guards\s*:\s*\{([\s\S]*?)\n\s*\}/)
  if (!match) return []
  return [...match[1].matchAll(/(?:^|[\s,{])([A-Za-z_][\w]*|['"][^'"]+['"])\s*:/gm)].map(
    ([, name]) => name.replace(/^['"]|['"]$/g, '')
  )
}

function databaseKind(source: string): SetupInspection['database'] {
  if (!source) return 'unknown'
  const sqlite = /(?:client\s*:\s*['"](?:better-sqlite3|sqlite3)['"]|sqlite)/i.test(source)
  const postgres = /(?:client\s*:\s*['"](?:pg|postgres)['"]|postgres)/i.test(source)
  if (sqlite && postgres) return 'unknown'
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
  const installedPackages = [
    ...Object.keys(packageJson.dependencies ?? {}),
    ...Object.keys(packageJson.devDependencies ?? {}),
  ]
  let migrationNames: string[] = []
  try {
    migrationNames = await readdir(join(root, 'database/migrations'))
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
    guards: existingGuards(files['config/auth.ts'] ?? ''),
    database: databaseKind(files['config/database.ts'] ?? ''),
    connection: /connection\s*:\s*['"](?!default)[^'"]+['"]/.test(files['config/database.ts'] ?? '')
      ? 'unsupported'
      : files['config/database.ts']
        ? 'default'
        : 'unknown',
    installedPackages,
    migrationNames,
    existingPrefix,
    routePaths,
    existingChoices,
  }
}
