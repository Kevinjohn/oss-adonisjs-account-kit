import {
  defaultImportName,
  defaultExpression,
  directProperty,
  hasAmbiguousRuntimeModuleImports,
  hasUnsafeBindingReferences,
  hasUnsafeObjectEntries,
  importedName,
  parseSetupSource,
  safeEnvGetter,
  unwrapStaticExpression,
} from './ts_source.js'
import { selectedEnvName } from './selected_environment.js'
import { nativeMailTransports } from './shared.js'

export async function mailerSelectionState(
  text: string,
  root: string,
  transportEnv: string | null
): Promise<'missing' | 'invalid' | 'unsafe' | 'unresolved' | 'present'> {
  let source
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
    try {
      selected = (await selectedEnvName(source, root, envBinding, selector, transportEnv)) ?? null
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
