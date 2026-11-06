import type * as TypeScript from 'typescript'
import { defaultImportName, parseSetupSource, walk, type SetupSource } from './ts_source.js'

/** AdonisJS joins a prefix and a pattern without doubled or trailing slashes. */
function dropSlash(input: string): string {
  if (input === '/') return '/'
  return `/${input.replace(/^\//, '').replace(/\/$/, '')}`
}

function withPrefix(prefix: string, path: string): string {
  const pattern = dropSlash(path)
  return `${dropSlash(prefix)}${pattern === '/' ? '' : pattern}`
}

/**
 * The literal `.prefix('...')` calls chained on `call`, in call order. Null when a prefix is not a
 * string literal, so the final path is unknown.
 */
function chainedPrefixes(source: SetupSource, call: TypeScript.Node): string[] | null {
  const { ts } = source
  const prefixes: string[] = []
  let current = call
  while (
    ts.isPropertyAccessExpression(current.parent) &&
    current.parent.expression === current &&
    ts.isCallExpression(current.parent.parent) &&
    current.parent.parent.expression === current.parent
  ) {
    const chained = current.parent.parent
    if (current.parent.name.text === 'prefix') {
      if (!ts.isStringLiteral(chained.arguments[0])) return null
      prefixes.push(chained.arguments[0].text)
    }
    current = chained
  }
  return prefixes
}

export async function staticRouteDefinitions(
  sourceText: string
): Promise<Array<{ method: string; path: string }>> {
  if (!sourceText) return []
  const source = await parseSetupSource(sourceText)
  const { ts } = source
  const router = defaultImportName(source, '@adonisjs/core/services/router')
  if (!router) return []
  const isRouterCall = (
    node: TypeScript.Node,
    names: string[]
  ): node is TypeScript.CallExpression =>
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === router &&
    names.includes(node.expression.name.text)
  const routes: Array<{ method: string; path: string }> = []
  walk(source, (node) => {
    if (
      !isRouterCall(node, ['get', 'post', 'put', 'patch', 'delete', 'any']) ||
      !ts.isStringLiteral(node.arguments[0])
    )
      return
    let path = node.arguments[0].text
    // Later prefixes wrap earlier ones, and outer groups wrap inner groups.
    const own = chainedPrefixes(source, node)
    if (!own) return
    for (const prefix of own) path = withPrefix(prefix, path)
    for (let scope = node.parent; scope; scope = scope.parent) {
      if (!ts.isArrowFunction(scope) && !ts.isFunctionExpression(scope)) continue
      const group = scope.parent
      if (!isRouterCall(group, ['group']) || group.arguments[0] !== scope) continue
      const prefixes = chainedPrefixes(source, group)
      if (!prefixes) return
      for (const prefix of prefixes) path = withPrefix(prefix, path)
    }
    routes.push({
      method: (node.expression as TypeScript.PropertyAccessExpression).name.text.toUpperCase(),
      path,
    })
  })
  return routes
}
