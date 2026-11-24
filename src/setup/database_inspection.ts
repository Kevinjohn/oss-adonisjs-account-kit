import type { SetupInspection } from './types.js'
import {
  getDefaultImportName,
  matchDirectObject,
  getDirectProperty,
  hasUnsafeObjectEntries,
  getImportedBindingName,
  parseSetupSource,
  inspectTopLevelConfig,
} from './ts_source.js'
import {
  SelectedEnvironmentValueError,
  resolveEnvironmentNameFromGetter,
} from './selected_environment.js'

/**
 * Finds the connection a Lucid database config selects, reading `DB_CONNECTION` from the selected
 * environment when the config uses it, without executing the config. Returns `null` when the
 * connection cannot be established statically.
 */
export async function inspectDatabaseConnection(
  sourceText: string,
  root: string,
  env?: NodeJS.ProcessEnv
) {
  if (!sourceText) return null
  const source = await parseSetupSource(sourceText)
  const configName = getImportedBindingName(source, '@adonisjs/lucid', 'defineConfig')
  const config = configName && inspectTopLevelConfig(source, configName)?.object
  if (!config || hasUnsafeObjectEntries(source, config)) return null
  const connection = getDirectProperty(source, config, 'connection')?.initializer
  const connections = matchDirectObject(
    source,
    getDirectProperty(source, config, 'connections')?.initializer ?? config
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
        (await resolveEnvironmentNameFromGetter(
          source,
          root,
          getDefaultImportName(source, '#start/env'),
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
  const selectedConnection = matchDirectObject(
    source,
    getDirectProperty(source, connections, selected)?.initializer ?? connections
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
  const client = getDirectProperty(source, connection, 'client')?.initializer
  if (!client || !ts.isStringLiteral(client)) return 'unknown'
  if (['better-sqlite3', 'sqlite3'].includes(client.text)) return 'sqlite'
  if (['pg', 'postgres', 'postgresql'].includes(client.text)) return 'postgres'
  if (client.text === 'mysql2') return 'mysql'
  return 'unsupported'
}
