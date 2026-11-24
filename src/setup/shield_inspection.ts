import {
  inspectDefaultExportExpression,
  getDirectProperty,
  getImportedBindingName,
  parseSetupSource,
  type SetupSource,
} from './ts_source.js'

export async function classifyShieldCsrfSetting(
  text: string
): Promise<'true' | 'false' | 'dynamic' | 'missing'> {
  let source: SetupSource
  try {
    source = await parseSetupSource(text)
  } catch {
    return 'missing'
  }
  const shieldFactory = getImportedBindingName(source, '@adonisjs/shield', 'defineConfig')
  const target = inspectDefaultExportExpression(source)
  const expression = target?.expression
  const object =
    expression && source.ts.isObjectLiteralExpression(expression)
      ? expression
      : shieldFactory &&
          expression &&
          source.ts.isCallExpression(expression) &&
          source.ts.isIdentifier(expression.expression) &&
          expression.expression.text === shieldFactory &&
          expression.arguments.length === 1 &&
          source.ts.isObjectLiteralExpression(expression.arguments[0])
        ? expression.arguments[0]
        : null
  const csrf = object && getDirectProperty(source, object, 'csrf')
  if (!csrf || !source.ts.isObjectLiteralExpression(csrf.initializer)) return 'missing'
  const enabled = getDirectProperty(source, csrf.initializer, 'enabled')
  if (!enabled) return 'missing'
  if (enabled.initializer.kind === source.ts.SyntaxKind.TrueKeyword) return 'true'
  if (enabled.initializer.kind === source.ts.SyntaxKind.FalseKeyword) return 'false'
  return 'dynamic'
}
