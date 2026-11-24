import type { SetupInspection } from './types.js'
import {
  matchDirectObject,
  getDirectProperty,
  hasUnsafeObjectEntries,
  getImportedBindingName,
  parseSetupSource,
  inspectTopLevelConfig,
  type SetupSource,
} from './ts_source.js'
import type * as TypeScript from 'typescript'

function getPropertyName(
  source: SetupSource,
  property: TypeScript.PropertyAssignment
): string | null {
  const { ts } = source
  if (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) return property.name.text
  return null
}

function matchDirectCall(
  source: SetupSource,
  node: TypeScript.Node,
  name: string | null
): TypeScript.CallExpression | null {
  const { ts } = source
  return name &&
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === name &&
    node.arguments.length === 1
    ? node
    : null
}

function extractDirectModelPath(
  source: SetupSource,
  provider: TypeScript.ObjectLiteralExpression
): string | null {
  const { ts } = source
  const model = getDirectProperty(source, provider, 'model')?.initializer
  if (
    !model ||
    !ts.isArrowFunction(model) ||
    model.parameters.length ||
    !ts.isCallExpression(model.body) ||
    model.body.expression.kind !== ts.SyntaxKind.ImportKeyword ||
    model.body.arguments.length !== 1 ||
    !ts.isStringLiteral(model.body.arguments[0])
  )
    return null
  return model.body.arguments[0].text
}

export async function inspectGuards(sourceText: string): Promise<{
  strategies: SetupInspection['guardStrategies']
  models: SetupInspection['guardModels']
  tokenProviders: SetupInspection['guardTokenProviders']
}> {
  const strategies: SetupInspection['guardStrategies'] = {}
  const models: SetupInspection['guardModels'] = {}
  const tokenProviders: SetupInspection['guardTokenProviders'] = {}
  if (!sourceText) return { strategies, models, tokenProviders }
  const source = await parseSetupSource(sourceText)
  const configName = getImportedBindingName(source, '@adonisjs/auth', 'defineConfig')
  const config = configName && inspectTopLevelConfig(source, configName)?.object
  const guards =
    config &&
    matchDirectObject(source, getDirectProperty(source, config, 'guards')?.initializer ?? config)
  if (!config || !guards || guards === config || hasUnsafeObjectEntries(source, guards))
    return { strategies, models, tokenProviders }
  const bindings = [
    {
      kind: 'session' as const,
      guard: getImportedBindingName(source, '@adonisjs/auth/session', 'sessionGuard'),
      provider: getImportedBindingName(source, '@adonisjs/auth/session', 'sessionUserProvider'),
    },
    {
      kind: 'access_tokens' as const,
      guard: getImportedBindingName(source, '@adonisjs/auth/access_tokens', 'tokensGuard'),
      provider: getImportedBindingName(
        source,
        '@adonisjs/auth/access_tokens',
        'tokensUserProvider'
      ),
    },
  ]
  for (const entry of guards.properties) {
    if (!source.ts.isPropertyAssignment(entry)) continue
    const name = getPropertyName(source, entry)
    if (!name) continue
    const binding = bindings.find(({ guard }) => matchDirectCall(source, entry.initializer, guard))
    if (!binding) continue
    strategies[name] = binding.kind
    const guardCall = matchDirectCall(source, entry.initializer, binding.guard)!
    const guardOptions = matchDirectObject(source, guardCall.arguments[0])
    const providerCall =
      guardOptions &&
      matchDirectCall(
        source,
        getDirectProperty(source, guardOptions, 'provider')?.initializer ?? guardOptions,
        binding.provider
      )
    const providerOptions = providerCall && matchDirectObject(source, providerCall.arguments[0])
    const model = providerOptions && extractDirectModelPath(source, providerOptions)
    if (model) models[name] = model
    if (binding.kind === 'access_tokens' && providerOptions) {
      const tokens = getDirectProperty(source, providerOptions, 'tokens')?.initializer
      if (tokens && source.ts.isStringLiteral(tokens)) tokenProviders[name] = tokens.text
    }
  }
  return { strategies, models, tokenProviders }
}
