import type { SetupDiagnostic, SetupFileChange, SetupInspection } from './types.js'
import { stripSourceComments } from './source_text.js'
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

export function lazyImportPath(source: SetupSource, node: TypeScript.Node): string | null {
  const { ts } = source
  if (!ts.isArrowFunction(node) || !ts.isCallExpression(node.body)) return null
  const call = node.body
  if (
    call.expression.kind !== ts.SyntaxKind.ImportKeyword ||
    call.arguments.length !== 1 ||
    !ts.isStringLiteral(call.arguments[0])
  )
    return null
  return call.arguments[0].text
}

export function callArray(
  source: SetupSource,
  receiver: string,
  method: string
): TypeScript.ArrayLiteralExpression | null {
  const matches: TypeScript.ArrayLiteralExpression[] = []
  walk(source, (node) => {
    if (
      exactCall(source, node, receiver, method) &&
      source.ts.isExpressionStatement(node.parent) &&
      node.parent.parent === source.file &&
      node.arguments.length === 1 &&
      source.ts.isArrayLiteralExpression(node.arguments[0])
    )
      matches.push(node.arguments[0])
  })
  return matches.length === 1 ? matches[0] : null
}

export function safeKernelService(
  source: SetupSource,
  module: string,
  binding: string,
  array: TypeScript.ArrayLiteralExpression
): boolean {
  const { ts } = source
  return (
    defaultImportName(source, module) === binding &&
    !hasUnsafeBindingReferences(source, binding, (call) => {
      const method =
        ts.isPropertyAccessExpression(call.expression) &&
        ts.isIdentifier(call.expression.expression) &&
        call.expression.expression.text === binding
          ? call.expression.name.text
          : null
      if (method === 'use')
        return (
          call.arguments.length === 1 &&
          call.arguments[0] === array &&
          ts.isExpressionStatement(call.parent) &&
          call.parent.parent === source.file
        )
      if (binding === 'server' && method === 'errorHandler')
        return (
          call.arguments.length === 1 &&
          Boolean(lazyImportPath(source, call.arguments[0])) &&
          ts.isExpressionStatement(call.parent) &&
          call.parent.parent === source.file
        )
      if (binding === 'router' && method === 'named')
        return (
          call.arguments.length === 1 &&
          ts.isObjectLiteralExpression(call.arguments[0]) &&
          !hasUnsafeObjectEntries(source, call.arguments[0]) &&
          call.arguments[0].properties.every(
            (property) =>
              ts.isPropertyAssignment(property) &&
              Boolean(lazyImportPath(source, property.initializer))
          ) &&
          ts.isVariableDeclaration(call.parent) &&
          ts.isIdentifier(call.parent.name) &&
          call.parent.name.text === 'middleware' &&
          ts.isVariableDeclarationList(call.parent.parent) &&
          Boolean(call.parent.parent.flags & ts.NodeFlags.Const) &&
          ts.isVariableStatement(call.parent.parent.parent) &&
          call.parent.parent.parent.parent === source.file
        )
      return false
    })
  )
}

export async function planArrayImports(
  changes: SetupFileChange[],
  state: SetupInspection,
  diagnostics: SetupDiagnostic[],
  path: string,
  _marker: string,
  imports: string[]
) {
  const previous = state.files[path]
  let source: SetupSource | null = null
  try {
    if (previous !== undefined) source = await parseSetupSource(previous)
  } catch {
    /* the diagnostic below identifies the supported shape */
  }
  const target = source && defaultExpression(source)
  let object: TypeScript.ObjectLiteralExpression | null = null
  if (source && target) {
    if (source.ts.isObjectLiteralExpression(target.expression)) object = target.expression
    else if (
      source.ts.isCallExpression(target.expression) &&
      source.ts.isIdentifier(target.expression.expression) &&
      target.expression.expression.text ===
        importedName(source, '@adonisjs/core/app', 'defineConfig') &&
      target.expression.arguments.length === 1 &&
      source.ts.isObjectLiteralExpression(target.expression.arguments[0])
    )
      object = target.expression.arguments[0]
  }
  const providers = source && object && directProperty(source, object, 'providers')
  if (
    !previous ||
    !source ||
    !providers ||
    !source.ts.isArrayLiteralExpression(providers.initializer)
  ) {
    diagnostic(
      diagnostics,
      path,
      `Expected a default-exported providers array in ${path}; configure these imports manually before activation`
    )
    return
  }
  const array = providers.initializer
  const present = new Set(
    array.elements.map((entry) => lazyImportPath(source!, entry)).filter(Boolean)
  )
  const missing = imports.filter((name) => !present.has(name))
  if (!missing.length) {
    changes.push({
      path,
      action: 'unchanged',
      content: previous,
      reason: 'Required imports are already present',
    })
    return
  }
  const at = array.getStart(source.file) + 1
  changes.push({
    path,
    action: 'update',
    expected: previous,
    content:
      previous.slice(0, at) +
      `\n${missing.map((name) => `    () => import('${name}'),`).join('\n')}` +
      previous.slice(at),
    reason: 'Register required framework providers or middleware',
  })
}

export function insertAfterArrayElement(
  source: SetupSource,
  array: TypeScript.ArrayLiteralExpression,
  index: number,
  importPath: string
): string {
  const element = array.elements[index]
  const next = array.elements[index + 1]
  const limit = next ? next.getStart(source.file) : array.getEnd() - 1
  const between = source.text.slice(element.getEnd(), limit)
  const executable = stripSourceComments(between)
  const comma = executable.indexOf(',')
  const withComma =
    comma < 0
      ? source.text.slice(0, element.getEnd()) + ',' + source.text.slice(element.getEnd())
      : source.text
  const afterExpression = element.getEnd() + (comma < 0 ? 1 : comma + 1)
  const lineComment = between.indexOf('//')
  const newline = between.indexOf('\n', lineComment < 0 ? 0 : lineComment)
  const at =
    lineComment >= 0 && newline >= 0
      ? element.getEnd() + newline + 1 + (comma < 0 ? 1 : 0)
      : afterExpression
  const entry = `  () => import('${importPath}'),`
  const insertion = at === afterExpression ? `\n${entry}` : `${entry}\n`
  return withComma.slice(0, at) + insertion + withComma.slice(at)
}

export async function planRouterMiddleware(
  changes: SetupFileChange[],
  state: SetupInspection,
  diagnostics: SetupDiagnostic[],
  session: boolean
) {
  const path = 'start/kernel.ts'
  const previous = state.files[path]
  if (!previous) {
    diagnostic(diagnostics, path, 'Expected one conventional router.use array in start/kernel.ts')
    return
  }
  let content = previous
  let source: SetupSource
  try {
    source = await parseSetupSource(content)
  } catch {
    diagnostic(diagnostics, path, 'Router middleware source must be valid TypeScript before setup')
    return
  }
  let array = callArray(source, 'router', 'use')
  const server = callArray(source, 'server', 'use')
  if (
    !array ||
    !server ||
    !safeKernelService(source, '@adonisjs/core/services/router', 'router', array) ||
    !safeKernelService(source, '@adonisjs/core/services/server', 'server', server)
  ) {
    diagnostic(
      diagnostics,
      path,
      'Expected one conventional server.use and router.use array in start/kernel.ts'
    )
    return
  }
  const body = '@adonisjs/core/bodyparser_middleware'
  const ordered = [
    body,
    ...(session
      ? ['@adonisjs/session/session_middleware', '@adonisjs/shield/shield_middleware']
      : []),
    '@adonisjs/auth/initialize_auth_middleware',
  ]
  if (
    server.elements.some((entry) => ordered.slice(1).includes(lazyImportPath(source, entry) ?? ''))
  ) {
    diagnostic(
      diagnostics,
      path,
      'Account middleware already appears in server.use; move it to the ordered router.use stack manually'
    )
    return
  }
  const paths = array.elements.map((entry) => lazyImportPath(source, entry))
  if (
    paths.some((name) => name === null) ||
    paths.filter((name) => name === body).length !== 1 ||
    ordered.some((name) => paths.filter((entry) => entry === name).length > 1)
  ) {
    diagnostic(
      diagnostics,
      path,
      'Router middleware layout is ambiguous; preserve body parser, session, Shield, then auth order manually'
    )
    return
  }
  const existing = ordered.map((name) => paths.indexOf(name)).filter((index) => index >= 0)
  if (existing.some((index, position) => position > 0 && index <= existing[position - 1])) {
    diagnostic(
      diagnostics,
      path,
      'Existing router middleware order is unsafe; require body parser, session, Shield, then auth'
    )
    return
  }
  for (let position = 1; position < ordered.length; position++) {
    const currentPaths = array.elements.map((entry) => lazyImportPath(source, entry))
    if (currentPaths.includes(ordered[position])) continue
    const preceding = currentPaths.indexOf(ordered[position - 1])
    if (preceding < 0) throw new Error('Missing previously planned router middleware')
    content = insertAfterArrayElement(source, array, preceding, ordered[position])
    try {
      source = await parseSetupSource(content)
    } catch {
      diagnostic(
        diagnostics,
        path,
        'Router middleware layout cannot be changed safely; use a complete import expression before setup'
      )
      return
    }
    array = callArray(source, 'router', 'use')
    if (!array) {
      diagnostic(
        diagnostics,
        path,
        'Router middleware layout cannot be changed safely; use a conventional array before setup'
      )
      return
    }
  }
  changes.push({
    path,
    action: content === previous ? 'unchanged' : 'update',
    expected: previous,
    content,
    reason: 'Keep account middleware after body parsing on registered routes',
  })
}

export async function planServerProofMiddleware(
  changes: SetupFileChange[],
  state: SetupInspection,
  diagnostics: SetupDiagnostic[]
) {
  const path = 'start/kernel.ts'
  const existing = changes.find((change) => change.path === path)
  const previous = existing?.content ?? state.files[path]
  let source: SetupSource | null = null
  try {
    if (previous) source = await parseSetupSource(previous)
  } catch {
    /* report supported shape below */
  }
  const array = source && callArray(source, 'server', 'use')
  if (
    !previous ||
    !source ||
    !array ||
    !safeKernelService(source, '@adonisjs/core/services/server', 'server', array)
  ) {
    diagnostic(
      diagnostics,
      path,
      'Expected one conventional server.use array before router middleware'
    )
    return
  }
  const name = '#middleware/account_kit_proof_headers_middleware'
  const proofPosition = array.elements.findIndex((entry) => lazyImportPath(source, entry) === name)
  if (proofPosition === 0) return
  if (proofPosition > 0) {
    diagnostic(
      diagnostics,
      path,
      'Move proof response headers to the first server.use position, before body parsing or terminating middleware'
    )
    return
  }
  const at = array.getStart(source.file) + 1
  const content = previous.slice(0, at) + `\n  () => import('${name}'),` + previous.slice(at)
  if (existing) {
    existing.content = content
    existing.action = existing.action === 'unchanged' ? 'update' : existing.action
    existing.reason += '; install early proof response headers'
  } else
    changes.push({
      path,
      action: 'update',
      expected: state.files[path],
      content,
      reason: 'Install early proof response headers before body parsing and Shield',
    })
}
