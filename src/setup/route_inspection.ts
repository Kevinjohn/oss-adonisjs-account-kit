import { defaultImportName, parseSetupSource, walk } from './ts_source.js'

export async function staticRouteDefinitions(
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
