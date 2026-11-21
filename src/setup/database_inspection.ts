import type { SetupInspection } from './types.js'
import {
  defaultImportName,
  directObject,
  directProperty,
  hasUnsafeObjectEntries,
  importedName,
  parseSetupSource,
  topLevelConfig,
} from './ts_source.js'
import { SelectedEnvironmentValueError, selectedEnvName } from './selected_environment.js'

export async function inspectDatabaseConnection(
  sourceText: string,
  root: string,
  env?: NodeJS.ProcessEnv
) {
  if (!sourceText) return null
  const source = await parseSetupSource(sourceText)
  const configName = importedName(source, '@adonisjs/lucid', 'defineConfig')
  const config = configName && topLevelConfig(source, configName)?.object
  if (!config || hasUnsafeObjectEntries(source, config)) return null
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
    return null
  const { ts } = source
  let selected: string | null = null
  if (ts.isStringLiteral(connection)) selected = connection.text
  else {
    // An empty, repeated or indirect DB_CONNECTION is unresolved, not a setup crash.
    try {
      selected =
        (await selectedEnvName(
          source,
          root,
          defaultImportName(source, '#start/env'),
          connection,
          'DB_CONNECTION',
          env
        )) ?? null
    } catch (error) {
      if (error instanceof SelectedEnvironmentValueError) return null
      throw error
    }
  }
  if (!selected) return null
  const selectedConnection = directObject(
    source,
    directProperty(source, connections, selected)?.initializer ?? connections
  )
  if (
    !selectedConnection ||
    selectedConnection === connections ||
    hasUnsafeObjectEntries(source, selectedConnection)
  )
    return null
  return { source, connection: selectedConnection }
}

export async function inspectDatabaseKind(
  sourceText: string,
  root: string,
  env?: NodeJS.ProcessEnv
): Promise<SetupInspection['database']> {
  const inspected = await inspectDatabaseConnection(sourceText, root, env)
  if (!inspected) return 'unknown'
  const { source, connection } = inspected
  const { ts } = source
  const client = directProperty(source, connection, 'client')?.initializer
  if (!client || !ts.isStringLiteral(client)) return 'unknown'
  if (['better-sqlite3', 'sqlite3'].includes(client.text)) return 'sqlite'
  if (['pg', 'postgres', 'postgresql'].includes(client.text)) return 'postgres'
  if (client.text === 'mysql2') return 'mysql'
  return 'unsupported'
}
