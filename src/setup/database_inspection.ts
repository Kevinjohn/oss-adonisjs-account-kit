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
import { selectedEnvName } from './selected_environment.js'

export async function databaseKind(
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
  else
    selected =
      (await selectedEnvName(
        source,
        root,
        defaultImportName(source, '#start/env'),
        connection,
        'DB_CONNECTION'
      )) ?? null
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
  if (client.text === 'mysql2') return 'mysql'
  return 'unsupported'
}
