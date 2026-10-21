import { resolveSelectedEnvironment } from './selected_environment_values.js'
import {
  defaultImportName,
  directProperty,
  exactCall,
  exportedObject,
  importedName,
  parseSetupSource,
  safeEnvGetter,
  type SetupSource,
} from './ts_source.js'
import type * as TypeScript from 'typescript'

/** The variable name in `env.get('NAME', ...)`, whatever the remaining arguments are. */
function envVariable(source: SetupSource, expression: TypeScript.Expression): string | null {
  const envBinding = defaultImportName(source, '#start/env')
  if (
    !envBinding ||
    !exactCall(source, expression, envBinding, 'get') ||
    !safeEnvGetter(source, envBinding) ||
    expression.arguments.length < 1 ||
    !source.ts.isStringLiteral(expression.arguments[0])
  )
    return null
  return expression.arguments[0].text
}

/** A diagnostic-only classifier; it never authorizes automatic attestation. */
export async function selectedSessionDiagnostic(
  text: string,
  root: string
): Promise<{
  name: string | null
  kind: string | null
} | null> {
  const source = await parseSetupSource(text)
  const object = exportedObject(
    source,
    importedName(source, '@adonisjs/session', 'defineConfig') ?? undefined
  )
  const store = object && directProperty(source, object, 'store')
  const stores = object && directProperty(source, object, 'stores')
  if (!store || !stores || !source.ts.isObjectLiteralExpression(stores.initializer)) return null
  let name: string | null = null
  if (source.ts.isStringLiteral(store.initializer)) name = store.initializer.text
  else {
    const variable = envVariable(source, store.initializer)
    if (variable) name = await resolveSelectedEnvironment(root, variable)
  }
  if (!name) return { name: null, kind: null }
  const selected = directProperty(source, stores.initializer, name)
  const initializer = selected?.initializer
  const kind =
    initializer &&
    source.ts.isCallExpression(initializer) &&
    source.ts.isPropertyAccessExpression(initializer.expression) &&
    source.ts.isIdentifier(initializer.expression.expression) &&
    initializer.expression.expression.text === 'stores'
      ? initializer.expression.name.text
      : null
  return { name, kind }
}
