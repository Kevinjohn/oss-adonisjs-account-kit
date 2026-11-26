import { envName } from './diagnostics.ts'
import { resolveSelectedEnvironment } from './selected_environment_values.ts'
import {
  getDefaultImportName,
  getDirectProperty,
  isExactCall,
  getExportedObject,
  getImportedBindingName,
  parseSetupSource,
  hasSafeEnvironmentGetter,
  type SetupSource,
} from './ts_source.ts'
import type * as TypeScript from 'typescript'

/** The variable name in `env.get('NAME', ...)`, whatever the remaining arguments are. */
function extractEnvironmentVariableName(
  source: SetupSource,
  expression: TypeScript.Expression
): string | null {
  const envBinding = getDefaultImportName(source, '#start/env')
  if (
    !envBinding ||
    !isExactCall(source, expression, envBinding, 'get') ||
    !hasSafeEnvironmentGetter(source, envBinding) ||
    expression.arguments.length < 1 ||
    !source.ts.isStringLiteral(expression.arguments[0])
  )
    return null
  const variable = expression.arguments[0].text
  return envName.test(variable) && variable.trim() === variable ? variable : null
}

/** A diagnostic-only classifier; it never authorizes automatic attestation. */
export async function inspectSelectedSessionStore(
  text: string,
  root: string,
  env?: NodeJS.ProcessEnv
): Promise<{
  name: string | null
  kind: string | null
} | null> {
  const source = await parseSetupSource(text)
  const object = getExportedObject(
    source,
    getImportedBindingName(source, '@adonisjs/session', 'defineConfig') ?? undefined
  )
  const store = object && getDirectProperty(source, object, 'store')
  const stores = object && getDirectProperty(source, object, 'stores')
  if (!store || !stores || !source.ts.isObjectLiteralExpression(stores.initializer)) return null
  let name: string | null = null
  if (source.ts.isStringLiteral(store.initializer)) name = store.initializer.text
  else {
    const variable = extractEnvironmentVariableName(source, store.initializer)
    if (variable) name = await resolveSelectedEnvironment(root, variable, env)
  }
  if (!name) return { name: null, kind: null }
  const storesName = getImportedBindingName(source, '@adonisjs/session', 'stores') ?? 'stores'
  const selected = getDirectProperty(source, stores.initializer, name)
  const initializer = selected?.initializer
  const kind =
    initializer &&
    source.ts.isCallExpression(initializer) &&
    source.ts.isPropertyAccessExpression(initializer.expression) &&
    source.ts.isIdentifier(initializer.expression.expression) &&
    initializer.expression.expression.text === storesName
      ? initializer.expression.name.text
      : null
  return { name, kind }
}
