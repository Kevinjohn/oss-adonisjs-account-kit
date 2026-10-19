import type { SetupInspection } from './types.js'
import {
  directObject,
  directProperty,
  hasUnsafeObjectEntries,
  importedName,
  parseSetupSource,
  topLevelConfig,
  type SetupSource,
} from './ts_source.js'
import type * as TypeScript from 'typescript'

function propertyName(source: SetupSource, property: TypeScript.PropertyAssignment): string | null {
  const { ts } = source
  if (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) return property.name.text
  return null
}

function directCall(
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

function directModel(
  source: SetupSource,
  provider: TypeScript.ObjectLiteralExpression
): string | null {
  const { ts } = source
  const model = directProperty(source, provider, 'model')?.initializer
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
  const configName = importedName(source, '@adonisjs/auth', 'defineConfig')
  const config = configName && topLevelConfig(source, configName)?.object
  const guards =
    config && directObject(source, directProperty(source, config, 'guards')?.initializer ?? config)
  if (!config || !guards || guards === config || hasUnsafeObjectEntries(source, guards))
    return { strategies, models, tokenProviders }
  const bindings = [
    {
      kind: 'session' as const,
      guard: importedName(source, '@adonisjs/auth/session', 'sessionGuard'),
      provider: importedName(source, '@adonisjs/auth/session', 'sessionUserProvider'),
    },
    {
      kind: 'access_tokens' as const,
      guard: importedName(source, '@adonisjs/auth/access_tokens', 'tokensGuard'),
      provider: importedName(source, '@adonisjs/auth/access_tokens', 'tokensUserProvider'),
    },
  ]
  for (const entry of guards.properties) {
    if (!source.ts.isPropertyAssignment(entry)) continue
    const name = propertyName(source, entry)
    if (!name) continue
    const binding = bindings.find(({ guard }) => directCall(source, entry.initializer, guard))
    if (!binding) continue
    strategies[name] = binding.kind
    const guardCall = directCall(source, entry.initializer, binding.guard)!
    const guardOptions = directObject(source, guardCall.arguments[0])
    const providerCall =
      guardOptions &&
      directCall(
        source,
        directProperty(source, guardOptions, 'provider')?.initializer ?? guardOptions,
        binding.provider
      )
    const providerOptions = providerCall && directObject(source, providerCall.arguments[0])
    const model = providerOptions && directModel(source, providerOptions)
    if (model) models[name] = model
    if (binding.kind === 'access_tokens' && providerOptions) {
      const tokens = directProperty(source, providerOptions, 'tokens')?.initializer
      if (tokens && source.ts.isStringLiteral(tokens)) tokenProviders[name] = tokens.text
    }
  }
  return { strategies, models, tokenProviders }
}
