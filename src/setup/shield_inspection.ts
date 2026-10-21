import {
  defaultExpression,
  directProperty,
  importedName,
  parseSetupSource,
  type SetupSource,
} from './ts_source.js'

export async function shieldCsrfState(
  text: string
): Promise<'true' | 'false' | 'dynamic' | 'missing'> {
  let source: SetupSource
  try {
    source = await parseSetupSource(text)
  } catch {
    return 'missing'
  }
  const shieldFactory = importedName(source, '@adonisjs/shield', 'defineConfig')
  const target = defaultExpression(source)
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
  const csrf = object && directProperty(source, object, 'csrf')
  if (!csrf || !source.ts.isObjectLiteralExpression(csrf.initializer)) return 'missing'
  const enabled = directProperty(source, csrf.initializer, 'enabled')
  if (!enabled) return 'missing'
  if (enabled.initializer.kind === source.ts.SyntaxKind.TrueKeyword) return 'true'
  if (enabled.initializer.kind === source.ts.SyntaxKind.FalseKeyword) return 'false'
  return 'dynamic'
}
