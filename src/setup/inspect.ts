import { readFile, readdir, lstat, realpath } from 'node:fs/promises'
import { join, relative as pathRelative, sep } from 'node:path'
import { safeSetupPath } from './safe_path.js'
import type { SetupChoices, SetupInspection } from './types.js'
import { parseSetupChoices } from './parse.js'
import {
  directProperty,
  hasUnsafeObjectEntries,
  importedName,
  defaultImportName,
  parseSetupSource,
  safeEnvGetter,
  topLevelConfig,
  walk,
  type SetupSource,
} from './ts_source.js'
import { resolveSelectedEnvironment } from './session_env.js'
import type * as TypeScript from 'typescript'

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

function propertyName(source: SetupSource, property: TypeScript.PropertyAssignment): string | null {
  const { ts } = source
  if (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) return property.name.text
  return null
}

function directObject(
  source: SetupSource,
  node: TypeScript.Node
): TypeScript.ObjectLiteralExpression | null {
  return source.ts.isObjectLiteralExpression(node) && !hasUnsafeObjectEntries(source, node)
    ? node
    : null
}

function directCall(
  source: SetupSource,
  node: TypeScript.Node,
  name: string | null
): TypeScript.CallExpression | null {
  const { ts } = source
  return name &&
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === name &&
    node.arguments.length === 1
    ? node
    : null
}

function directModel(
  source: SetupSource,
  provider: TypeScript.ObjectLiteralExpression
): string | null {
  const { ts } = source
  const model = directProperty(source, provider, 'model')?.initializer
  if (
    !model ||
    !ts.isArrowFunction(model) ||
    model.parameters.length ||
    !ts.isCallExpression(model.body) ||
    model.body.expression.kind !== ts.SyntaxKind.ImportKeyword ||
    model.body.arguments.length !== 1 ||
    !ts.isStringLiteral(model.body.arguments[0])
  )
    return null
  return model.body.arguments[0].text
}

async function inspectGuards(sourceText: string): Promise<{
  strategies: SetupInspection['guardStrategies']
  models: SetupInspection['guardModels']
  tokenProviders: SetupInspection['guardTokenProviders']
}> {
  const strategies: SetupInspection['guardStrategies'] = {}
  const models: SetupInspection['guardModels'] = {}
  const tokenProviders: SetupInspection['guardTokenProviders'] = {}
  if (!sourceText) return { strategies, models, tokenProviders }
  const source = await parseSetupSource(sourceText)
  const configName = importedName(source, '@adonisjs/auth', 'defineConfig')
  const config = configName && topLevelConfig(source, configName)?.object
  const guards =
    config && directObject(source, directProperty(source, config, 'guards')?.initializer ?? config)
  if (!config || !guards || guards === config || hasUnsafeObjectEntries(source, guards))
    return { strategies, models, tokenProviders }
  const bindings = [
    {
      kind: 'session' as const,
      guard: importedName(source, '@adonisjs/auth/session', 'sessionGuard'),
      provider: importedName(source, '@adonisjs/auth/session', 'sessionUserProvider'),
    },
    {
      kind: 'access_tokens' as const,
      guard: importedName(source, '@adonisjs/auth/access_tokens', 'tokensGuard'),
      provider: importedName(source, '@adonisjs/auth/access_tokens', 'tokensUserProvider'),
    },
  ]
  for (const entry of guards.properties) {
    if (!source.ts.isPropertyAssignment(entry)) continue
    const name = propertyName(source, entry)
    if (!name) continue
    const binding = bindings.find(({ guard }) => directCall(source, entry.initializer, guard))
    if (!binding) continue
    strategies[name] = binding.kind
    const guardCall = directCall(source, entry.initializer, binding.guard)!
    const guardOptions = directObject(source, guardCall.arguments[0])
    const providerCall =
      guardOptions &&
      directCall(
        source,
        directProperty(source, guardOptions, 'provider')?.initializer ?? guardOptions,
        binding.provider
      )
    const providerOptions = providerCall && directObject(source, providerCall.arguments[0])
    const model = providerOptions && directModel(source, providerOptions)
    if (model) models[name] = model
    if (binding.kind === 'access_tokens' && providerOptions) {
      const tokens = directProperty(source, providerOptions, 'tokens')?.initializer
      if (tokens && source.ts.isStringLiteral(tokens)) tokenProviders[name] = tokens.text
    }
  }
  return { strategies, models, tokenProviders }
}

async function databaseKind(
  sourceText: string,
  root: string
): Promise<SetupInspection['database']> {
  if (!sourceText) return 'unknown'
  const source = await parseSetupSource(sourceText)
  const configName = importedName(source, '@adonisjs/lucid', 'defineConfig')
  const config = configName && topLevelConfig(source, configName)?.object
  if (!config || hasUnsafeObjectEntries(source, config)) return 'unknown'
  const connection = directProperty(source, config, 'connection')?.initializer
  const connections = directObject(
    source,
    directProperty(source, config, 'connections')?.initializer ?? config
  )
  if (
    !connection ||
    !connections ||
    connections === config ||
    hasUnsafeObjectEntries(source, connections)
  )
    return 'unknown'
  const { ts } = source
  let selected: string | null = null
  if (ts.isStringLiteral(connection)) selected = connection.text
  else if (
    ts.isCallExpression(connection) &&
    ts.isPropertyAccessExpression(connection.expression) &&
    ts.isIdentifier(connection.expression.expression) &&
    connection.expression.expression.text === defaultImportName(source, '#start/env') &&
    connection.expression.name.text === 'get' &&
    connection.arguments.length >= 1 &&
    connection.arguments.length <= 2 &&
    ts.isStringLiteral(connection.arguments[0]) &&
    connection.arguments[0].text === 'DB_CONNECTION' &&
    (connection.arguments.length === 1 || ts.isStringLiteral(connection.arguments[1]))
  ) {
    const envBinding = defaultImportName(source, '#start/env')
    if (!envBinding || !safeEnvGetter(source, envBinding)) return 'unknown'
    selected =
      (await resolveSelectedEnvironment(root, 'DB_CONNECTION')) ??
      (connection.arguments.length === 2
        ? (connection.arguments[1] as TypeScript.StringLiteral).text
        : null)
  }
  if (!selected) return 'unknown'
  const selectedConnection = directObject(
    source,
    directProperty(source, connections, selected)?.initializer ?? connections
  )
  if (
    !selectedConnection ||
    selectedConnection === connections ||
    hasUnsafeObjectEntries(source, selectedConnection)
  )
    return 'unknown'
  const client = directProperty(source, selectedConnection, 'client')?.initializer
  if (!client || !ts.isStringLiteral(client)) return 'unknown'
  if (['better-sqlite3', 'sqlite3'].includes(client.text)) return 'sqlite'
  if (['pg', 'postgres'].includes(client.text)) return 'postgres'
  return 'unsupported'
}

async function staticRouteDefinitions(
  sourceText: string
): Promise<Array<{ method: string; path: string }>> {
  if (!sourceText) return []
  const source = await parseSetupSource(sourceText)
  const router = defaultImportName(source, '@adonisjs/core/services/router')
  if (!router) return []
  const routes: Array<{ method: string; path: string }> = []
  walk(source, (node) => {
    const { ts } = source
    if (
      !ts.isCallExpression(node) ||
      !ts.isPropertyAccessExpression(node.expression) ||
      !ts.isIdentifier(node.expression.expression) ||
      node.expression.expression.text !== router ||
      !['get', 'post', 'put', 'patch', 'delete', 'any'].includes(node.expression.name.text) ||
      !ts.isStringLiteral(node.arguments[0])
    )
      return
    routes.push({ method: node.expression.name.text.toUpperCase(), path: node.arguments[0].text })
  })
  return routes
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
