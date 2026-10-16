import { readFile, readdir, lstat, realpath } from 'node:fs/promises'
import { join, relative as pathRelative, sep } from 'node:path'
import { safeSetupPath } from './safe_path.js'
import type { SetupChoices, SetupInspection } from './types.js'
import { parseSetupChoices } from './parse.js'
import { maskSourceLiteralBodies, stripSourceComments } from './source_text.js'

const inspectedFiles = [
  'package.json',
  'adonisrc.ts',
  'config/auth.ts',
  'config/database.ts',
  'config/limiter.ts',
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

function matchedLiteral(source: string, match: RegExpMatchArray, group: number): string | null {
  const range = match.indices?.[group]
  if (!range) return null
  const literal = source.slice(...range)
  const value = /^(['"])([^'"\\]*)\1$/.exec(literal)
  return value?.[2] ?? null
}

function matchedKey(source: string, match: RegExpMatchArray): string | null {
  const range = match.indices?.[1]
  if (!range) return null
  const key = source.slice(...range)
  const name = key[0] === "'" || key[0] === '"' ? matchedLiteral(source, match, 1) : key
  return name && /^[A-Za-z_][\w-]*$/.test(name) ? name : null
}

function guardStrategies(source: string, structure: string): SetupInspection['guardStrategies'] {
  const strategies: SetupInspection['guardStrategies'] = {}
  for (const match of structure.matchAll(
    /(?:^|[,{\n])\s*(['"]\s*['"]|[\w-]+)\s*:\s*(sessionGuard|tokensGuard)\s*\(/dg
  )) {
    const name = matchedKey(source, match)
    if (!name) continue
    strategies[name] = match[2] === 'sessionGuard' ? 'session' : 'access_tokens'
  }
  return strategies
}

function guardModels(source: string, structure: string): SetupInspection['guardModels'] {
  const models: Record<string, string> = {}
  for (const match of structure.matchAll(
    /(?:^|[,{\n])\s*(['"]\s*['"]|[\w-]+)\s*:\s*(?:sessionGuard|tokensGuard)\s*\(\s*\{[^}]*?provider\s*:\s*(?:sessionUserProvider|tokensUserProvider)\s*\(\s*\{[^}]*?model\s*:\s*\(\)\s*=>\s*import\(\s*(['"]\s*['"])\s*\)/dg
  )) {
    const name = matchedKey(source, match)
    const model = matchedLiteral(source, match, 2)
    if (name && model) models[name] = model
  }
  return models
}

function databaseKind(source: string): SetupInspection['database'] {
  if (!source) return 'unknown'
  const structure = maskSourceLiteralBodies(source)
  const literalSelection = /\bconnection\s*:\s*(['"]\s*['"])/d.exec(structure)
  const environmentSelection =
    /\bconnection\s*:\s*env\.get\(\s*(['"]\s*['"])(?:\s*,\s*(['"]\s*['"]))?/d.exec(structure)
  const selected = literalSelection
    ? matchedLiteral(source, literalSelection, 1)
    : environmentSelection && matchedLiteral(source, environmentSelection, 1) === 'DB_CONNECTION'
      ? (process.env.DB_CONNECTION ?? matchedLiteral(source, environmentSelection, 2))
      : null
  let clientSource = structure
  let clientOriginal = source
  if (selected) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(selected)) return 'unknown'
    const connections = /\bconnections\s*:/.exec(structure)?.index ?? -1
    if (connections < 0) return 'unknown'
    const entries = structure.slice(connections)
    const entry = [
      ...entries.matchAll(
        /(?:^|[,\s{])(['"]\s*['"]|[A-Za-z_][\w]*)\s*:\s*(?:defineConfig\s*\()?\s*\{/dg
      ),
    ].find((match) => matchedKey(source.slice(connections), match) === selected)
    if (!entry) return 'unknown'
    const begin = connections + entry.index + entry[0].length
    let depth = 1
    let end = begin
    while (end < structure.length && depth) {
      if (structure[end] === '{') depth++
      if (structure[end] === '}') depth--
      end++
    }
    if (depth) return 'unknown'
    clientSource = structure.slice(begin, end - 1)
    clientOriginal = source.slice(begin, end - 1)
  } else if (/\bconnections\s*:/.test(structure)) return 'unknown'
  const clientMatch = /\bclient\s*:\s*(['"]\s*['"])/d.exec(clientSource)
  const client = clientMatch ? matchedLiteral(clientOriginal, clientMatch, 1) : null
  if (!client) return 'unknown'
  if (['better-sqlite3', 'sqlite3'].includes(client)) return 'sqlite'
  if (['pg', 'postgres'].includes(client)) return 'postgres'
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
      const metadata = await safeSetupPath(root, join(fromRoot, 'package.json'))
      const metadataStat = await lstat(metadata)
      if (!metadataStat.isFile())
        throw new Error(`Setup cannot inspect non-regular file ${metadata}`)
      const installed = JSON.parse(await readFile(metadata, 'utf8')) as {
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
  const routeSource = stripSourceComments(files['start/routes.ts'] ?? '')
  const routeDefinitions = [
    ...routeSource.matchAll(/\.(get|post|put|patch|delete|any)\(\s*['"]([^'"]+)['"]/g),
  ].map((match) => ({ method: match[1].toUpperCase(), path: match[2] }))
  const routePaths = routeDefinitions.map(({ path }) => path)
  const authSource = files['config/auth.ts'] ?? ''
  const authStructure = maskSourceLiteralBodies(authSource)
  const strategies = guardStrategies(authSource, authStructure)
  return {
    root,
    existingInstallation: Boolean(
      files['config/account_kit.ts'] || files['config/account_kit_setup.json']
    ),
    files,
    guards: Object.keys(strategies),
    guardStrategies: strategies,
    guardModels: guardModels(authSource, authStructure),
    database: databaseKind(files['config/database.ts'] ?? ''),
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
