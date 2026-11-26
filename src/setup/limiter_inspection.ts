import {
  getDirectProperty,
  getDefaultImportName,
  hasUnsafeBindingReferences,
  hasUnsafeObjectEntries,
  getImportedBindingName,
  parseSetupSource,
  inspectTopLevelConfig,
} from './ts_source.ts'
import { resolveEnvironmentNameFromGetter } from './selected_environment.ts'

export async function inspectLimiterConfiguration(
  text: string,
  root: string,
  env?: NodeJS.ProcessEnv
): Promise<'valid' | 'invalid' | 'unresolved'> {
  let source
  try {
    source = await parseSetupSource(text)
  } catch {
    return 'invalid'
  }
  const defineConfigName = getImportedBindingName(source, '@adonisjs/limiter', 'defineConfig')
  const storesName = getImportedBindingName(source, '@adonisjs/limiter', 'stores')
  const config = defineConfigName && inspectTopLevelConfig(source, defineConfigName)?.object
  if (!config || !storesName || hasUnsafeObjectEntries(source, config)) return 'invalid'
  const selected = getDirectProperty(source, config, 'default')?.initializer
  const stores = getDirectProperty(source, config, 'stores')?.initializer
  if (!selected || !stores || !source.ts.isObjectLiteralExpression(stores)) return 'invalid'
  if (hasUnsafeObjectEntries(source, stores)) return 'invalid'
  let name: string | null = null
  if (source.ts.isStringLiteral(selected)) name = selected.text
  else {
    try {
      name =
        (await resolveEnvironmentNameFromGetter(
          source,
          root,
          getDefaultImportName(source, '#start/env'),
          selected,
          undefined,
          env
        )) ?? null
    } catch {
      return 'unresolved'
    }
  }
  if (!name) return 'unresolved'
  const factory = getDirectProperty(source, stores, name)?.initializer
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
