import type { SetupDiagnostic, SetupFileChange, SetupInspection } from './types.ts'
import {
  getDefaultImportName,
  hasAmbiguousRuntimeModuleImports,
  hasUnsafeBindingReferences,
  parseSetupSource,
  walk,
  type SetupSource,
} from './ts_source.ts'
import type * as TypeScript from 'typescript'
import { addSetupDiagnostic } from './shared.ts'

export async function planRouteImport(
  changes: SetupFileChange[],
  state: SetupInspection,
  diagnostics: SetupDiagnostic[]
) {
  const path = 'start/routes.ts'
  const previous = state.files[path]
  if (previous === undefined) {
    addSetupDiagnostic(
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
    addSetupDiagnostic(
      diagnostics,
      path,
      'Application route source must be valid TypeScript before setup'
    )
    return
  }
  const httpEntry = '@kevinjohn/adonisjs-account-kit/http'
  const mountImports = source.file.statements
    .filter(source.ts.isImportDeclaration)
    .filter(
      (node) =>
        source.ts.isStringLiteral(node.moduleSpecifier) &&
        node.moduleSpecifier.text === httpEntry &&
        !node.importClause?.isTypeOnly
    )
  // A direct mount resolves the managed routes service or uses the ManagedRoutes class.
  let directMount = mountImports.some((node) => {
    const bindings = node.importClause?.namedBindings
    return (
      !!bindings &&
      source.ts.isNamedImports(bindings) &&
      bindings.elements.some(
        (element) =>
          !element.isTypeOnly &&
          (element.propertyName?.text ?? element.name.text) === 'ManagedRoutes'
      )
    )
  })
  const namespaceMounts = mountImports.flatMap((node) => {
    const bindings = node.importClause?.namedBindings
    return bindings && source.ts.isNamespaceImport(bindings) ? [bindings.name.text] : []
  })
  const routeRouter = getDefaultImportName(source, '@adonisjs/core/services/router')
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
    addSetupDiagnostic(
      diagnostics,
      path,
      'Resolve router service origins before mounting managed routes'
    )
    return
  }
  const isMountSupported =
    !hasAmbiguousRuntimeModuleImports(source, httpEntry) &&
    !namespaceMounts.some((name) => hasUnsafeBindingReferences(source, name, () => false))
  walk(source, (node) => {
    if (
      (source.ts.isStringLiteral(node) || source.ts.isNoSubstitutionTemplateLiteral(node)) &&
      node.text === 'account_kit.managed_routes'
    )
      directMount = true
  })
  if (directMount || !isMountSupported) {
    addSetupDiagnostic(
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
    addSetupDiagnostic(
      diagnostics,
      path,
      'Existing Account Kit route import differs; resolve it manually'
    )
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
