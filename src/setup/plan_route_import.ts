import type { SetupDiagnostic, SetupFileChange, SetupInspection } from './types.js'
import {
  defaultImportName,
  hasAmbiguousRuntimeModuleImports,
  hasUnsafeBindingReferences,
  importedName,
  parseSetupSource,
  walk,
  type SetupSource,
} from './ts_source.js'
import type * as TypeScript from 'typescript'
import { diagnostic } from './shared.js'

export async function planRouteImport(
  changes: SetupFileChange[],
  state: SetupInspection,
  diagnostics: SetupDiagnostic[]
) {
  const path = 'start/routes.ts'
  const previous = state.files[path]
  if (previous === undefined) {
    diagnostic(
      diagnostics,
      path,
      'Application route file is missing; create it before managed setup'
    )
    return
  }
  let source: SetupSource
  try {
    source = await parseSetupSource(previous)
  } catch {
    diagnostic(diagnostics, path, 'Application route source must be valid TypeScript before setup')
    return
  }
  let directMount = false
  const mountImports = source.file.statements
    .filter(source.ts.isImportDeclaration)
    .filter(
      (node) =>
        source.ts.isStringLiteral(node.moduleSpecifier) &&
        node.moduleSpecifier.text === 'adonisjs-account-kit/http' &&
        !node.importClause?.isTypeOnly
    )
  const namedMounts = mountImports.flatMap((node) => {
    const bindings = node.importClause?.namedBindings
    return bindings && source.ts.isNamedImports(bindings)
      ? bindings.elements.filter(
          (element) =>
            !element.isTypeOnly &&
            (element.propertyName?.text ?? element.name.text) === 'registerManagedRoutes'
        )
      : []
  })
  const namespaceMounts = mountImports.flatMap((node) => {
    const bindings = node.importClause?.namedBindings
    return bindings && source.ts.isNamespaceImport(bindings) ? [bindings.name.text] : []
  })
  const mountBinding = importedName(source, 'adonisjs-account-kit/http', 'registerManagedRoutes')
  const routeRouter = defaultImportName(source, '@adonisjs/core/services/router')
  if (
    hasAmbiguousRuntimeModuleImports(source, '@adonisjs/core/services/router') ||
    (routeRouter &&
      hasUnsafeBindingReferences(
        source,
        routeRouter,
        (call) =>
          source.ts.isPropertyAccessExpression(call.expression) &&
          source.ts.isIdentifier(call.expression.expression) &&
          call.expression.expression.text === routeRouter &&
          [
            'get',
            'post',
            'put',
            'patch',
            'delete',
            'any',
            'match',
            'group',
            'resource',
            'on',
            'redirect',
            'route',
          ].includes(call.expression.name.text)
      ))
  ) {
    diagnostic(
      diagnostics,
      path,
      'Resolve router service provenance before mounting managed routes'
    )
    return
  }
  let unsupportedMount =
    hasAmbiguousRuntimeModuleImports(source, 'adonisjs-account-kit/http') ||
    namedMounts.length > 1 ||
    namespaceMounts.some((name) => hasUnsafeBindingReferences(source, name, () => false))
  walk(source, (node) => {
    if (mountBinding && source.ts.isIdentifier(node) && node.text === mountBinding) {
      const parent = node.parent
      const declaration = source.ts.isImportSpecifier(parent) && parent.name === node
      const call = source.ts.isCallExpression(parent) && parent.expression === node
      const propertyName = source.ts.isPropertyAccessExpression(parent) && parent.name === node
      if (!declaration && !call && !propertyName) unsupportedMount = true
    }
    if (
      source.ts.isCallExpression(node) &&
      source.ts.isIdentifier(node.expression) &&
      node.expression.text === mountBinding
    )
      directMount = true
    if (
      source.ts.isCallExpression(node) &&
      source.ts.isIdentifier(node.expression) &&
      node.expression.text === 'registerManagedRoutes' &&
      !mountBinding
    )
      unsupportedMount = true
    if (
      source.ts.isCallExpression(node) &&
      source.ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'registerManagedRoutes'
    )
      unsupportedMount = true
  })
  if (directMount || unsupportedMount) {
    diagnostic(
      diagnostics,
      path,
      'Existing direct managed route mount must be reconciled before setup adds another'
    )
    return
  }
  const imports = source.file.statements
    .filter(source.ts.isImportDeclaration)
    .filter((node) => source.ts.isStringLiteral(node.moduleSpecifier))
    .filter(
      (node) =>
        !node.importClause?.isTypeOnly &&
        (!node.importClause?.namedBindings ||
          !source.ts.isNamedImports(node.importClause.namedBindings) ||
          node.importClause.namedBindings.elements.some((element) => !element.isTypeOnly))
    )
    .map((node) => (node.moduleSpecifier as TypeScript.StringLiteral).text)
  if (imports.includes('./account_kit_routes.js')) {
    changes.push({
      path,
      action: 'unchanged',
      content: previous,
      reason: 'Managed route mount is already active',
    })
    return
  }
  if (imports.some((name) => name.includes('account_kit_routes'))) {
    diagnostic(diagnostics, path, 'Existing Account Kit route import differs; resolve it manually')
    return
  }
  changes.push({
    path,
    action: 'update',
    expected: previous,
    content: `${previous.trimEnd()}\n\nimport './account_kit_routes.js'\n`,
    reason: 'Explicitly mount the package-maintained endpoints',
  })
}
