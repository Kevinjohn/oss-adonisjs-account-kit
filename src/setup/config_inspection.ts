import { resolveSelectedEnvironment, selectedSessionEnvironment } from './session_env.js'
import {
  defaultExpression,
  defaultImportName,
  directProperty,
  exactCall,
  hasAmbiguousRuntimeModuleImports,
  hasUnsafeObjectEntries,
  hasUnsafeBindingReferences,
  importedName,
  parseSetupSource,
  safeEnvGetter,
  topLevelConfig,
  unwrapStaticExpression,
  type SetupSource,
} from './ts_source.js'
import type * as TypeScript from 'typescript'
import { nativeMailTransports } from './shared.js'

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

export async function mailerSelectionState(
  text: string,
  root: string,
  transportEnv: string | null
): Promise<'missing' | 'invalid' | 'unsafe' | 'unresolved' | 'present'> {
  let source: SetupSource
  try {
    source = await parseSetupSource(text)
  } catch {
    return 'unsafe'
  }
  const { ts } = source
  if (
    hasAmbiguousRuntimeModuleImports(source, '@adonisjs/mail') ||
    hasAmbiguousRuntimeModuleImports(source, '#start/env')
  )
    return 'unsafe'
  const envBinding =
    defaultImportName(source, '#start/env') ?? importedName(source, '#start/env', 'default')
  if (envBinding && !safeEnvGetter(source, envBinding)) return 'unsafe'
  const exported = defaultExpression(source)?.expression
  if (!exported) return 'unsafe'
  const target = unwrapStaticExpression(source, exported)
  const factory = importedName(source, '@adonisjs/mail', 'defineConfig')
  if (
    factory &&
    hasUnsafeBindingReferences(
      source,
      factory,
      (call) =>
        ts.isIdentifier(call.expression) && call.expression.text === factory && call === target
    )
  )
    return 'unsafe'
  const object =
    target && ts.isObjectLiteralExpression(target)
      ? target
      : factory &&
          target &&
          ts.isCallExpression(target) &&
          ts.isIdentifier(target.expression) &&
          target.expression.text === factory &&
          target.arguments.length === 1 &&
          ts.isObjectLiteralExpression(target.arguments[0])
        ? target.arguments[0]
        : null
  if (!object || hasUnsafeObjectEntries(source, object)) return 'unsafe'
  const mailersValue = directProperty(source, object, 'mailers')?.initializer
  const mailers = mailersValue && unwrapStaticExpression(source, mailersValue)
  if (!mailers || !ts.isObjectLiteralExpression(mailers) || hasUnsafeObjectEntries(source, mailers))
    return 'unsafe'
  if (mailers.properties.length === 0) return 'missing'
  const selectorValue = directProperty(source, object, 'default')?.initializer
  const selector = selectorValue && unwrapStaticExpression(source, selectorValue)
  let selected: string | null = null
  if (selector && ts.isStringLiteral(selector)) selected = selector.text
  else if (selector && transportEnv) {
    if (!envBinding || !exactCall(source, selector, envBinding, 'get')) return 'unsafe'
    const args = selector.arguments
    if (
      args.length < 1 ||
      args.length > 2 ||
      !ts.isStringLiteral(args[0]) ||
      args[0].text !== transportEnv ||
      (args.length === 2 && !ts.isStringLiteral(args[1]))
    )
      return 'unsafe'
    try {
      selected =
        (await resolveSelectedEnvironment(root, transportEnv)) ??
        (args.length === 2 ? (args[1] as TypeScript.StringLiteral).text : null)
    } catch {
      return 'unsafe'
    }
  }
  if (!selected) return 'unsafe'
  const mailer = directProperty(source, mailers, selected)
  if (!mailer) return 'missing'
  const value = unwrapStaticExpression(source, mailer.initializer)
  if (
    value.kind === ts.SyntaxKind.NullKeyword ||
    ts.isVoidExpression(value) ||
    (ts.isIdentifier(value) && value.text === 'undefined') ||
    value.kind === ts.SyntaxKind.TrueKeyword ||
    value.kind === ts.SyntaxKind.FalseKeyword ||
    ts.isNumericLiteral(value) ||
    ts.isBigIntLiteral(value) ||
    ts.isStringLiteral(value) ||
    ts.isNoSubstitutionTemplateLiteral(value) ||
    ts.isTemplateExpression(value) ||
    ts.isArrayLiteralExpression(value) ||
    ts.isObjectLiteralExpression(value) ||
    ts.isRegularExpressionLiteral(value) ||
    ts.isPrefixUnaryExpression(value)
  )
    return 'invalid'
  const transports = importedName(source, '@adonisjs/mail', 'transports')
  if (
    transports &&
    hasUnsafeBindingReferences(
      source,
      transports,
      (call) =>
        ts.isPropertyAccessExpression(call.expression) &&
        nativeMailTransports.has(call.expression.name.text)
    )
  )
    return 'unsafe'
  if (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) return 'present'
  if (
    transports &&
    ts.isCallExpression(value) &&
    ts.isPropertyAccessExpression(value.expression) &&
    ts.isIdentifier(value.expression.expression) &&
    value.expression.expression.text === transports &&
    nativeMailTransports.has(value.expression.name.text)
  )
    return 'present'
  if (
    ts.isCallExpression(value) &&
    (ts.isIdentifier(value.expression) || ts.isPropertyAccessExpression(value.expression)) &&
    !(
      ts.isPropertyAccessExpression(value.expression) &&
      ts.isIdentifier(value.expression.expression) &&
      [envBinding, transports].includes(value.expression.expression.text)
    )
  )
    return 'unresolved'
  return 'unsafe'
}

export async function limiterConfigurationState(
  text: string,
  root: string
): Promise<'valid' | 'invalid' | 'unresolved'> {
  let source: SetupSource
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
    const env = defaultImportName(source, '#start/env')
    if (!env || !exactCall(source, selected, env, 'get') || !safeEnvGetter(source, env))
      return 'unresolved'
    const args = selected.arguments
    if (
      args.length < 1 ||
      args.length > 2 ||
      !source.ts.isStringLiteral(args[0]) ||
      !/^[A-Z][A-Z0-9_]*$/.test(args[0].text) ||
      (args.length === 2 && !source.ts.isStringLiteral(args[1]))
    )
      return 'unresolved'
    try {
      name =
        (await selectedSessionEnvironment(root, args[0].text)) ??
        (args.length === 2 ? (args[1] as TypeScript.StringLiteral).text : null)
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
