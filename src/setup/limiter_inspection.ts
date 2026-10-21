import {
  directProperty,
  defaultImportName,
  hasUnsafeBindingReferences,
  hasUnsafeObjectEntries,
  importedName,
  parseSetupSource,
  topLevelConfig,
} from './ts_source.js'
import { selectedEnvName } from './selected_environment.js'

export async function limiterConfigurationState(
  text: string,
  root: string
): Promise<'valid' | 'invalid' | 'unresolved'> {
  let source
  try {
    source = await parseSetupSource(text)
  } catch {
    return 'invalid'
  }
  const defineConfigName = importedName(source, '@adonisjs/limiter', 'defineConfig')
  const storesName = importedName(source, '@adonisjs/limiter', 'stores')
  const config = defineConfigName && topLevelConfig(source, defineConfigName)?.object
  if (!config || !storesName || hasUnsafeObjectEntries(source, config)) return 'invalid'
  const selected = directProperty(source, config, 'default')?.initializer
  const stores = directProperty(source, config, 'stores')?.initializer
  if (!selected || !stores || !source.ts.isObjectLiteralExpression(stores)) return 'invalid'
  if (hasUnsafeObjectEntries(source, stores)) return 'invalid'
  let name: string | null = null
  if (source.ts.isStringLiteral(selected)) name = selected.text
  else {
    try {
      name =
        (await selectedEnvName(source, root, defaultImportName(source, '#start/env'), selected)) ??
        null
    } catch {
      return 'unresolved'
    }
  }
  if (!name) return 'unresolved'
  const factory = directProperty(source, stores, name)?.initializer
  if (
    !factory ||
    !source.ts.isCallExpression(factory) ||
    !source.ts.isPropertyAccessExpression(factory.expression) ||
    !source.ts.isIdentifier(factory.expression.expression) ||
    factory.expression.expression.text !== storesName ||
    !['database', 'memory', 'redis'].includes(factory.expression.name.text)
  )
    return 'invalid'
  if (
    hasUnsafeBindingReferences(source, storesName, (call) => {
      if (!source.ts.isPropertyAccessExpression(call.expression)) return false
      return (
        ['database', 'memory', 'redis'].includes(call.expression.name.text) &&
        call.getStart(source.file) > stores.getStart(source.file) &&
        call.getEnd() < stores.getEnd()
      )
    })
  )
    return 'invalid'
  return 'valid'
}
