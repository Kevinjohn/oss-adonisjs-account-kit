import type { SetupDiagnostic, SetupFileChange, SetupInspection } from './types.js'
import { stripSourceComments } from './strip_source_comments.js'
import {
  defaultImportName,
  hasUnsafeObjectEntries,
  hasUnsafeBindingReferences,
  parseSetupSource,
  lazyImportPath,
  callArray,
  type SetupSource,
} from './ts_source.js'
import type * as TypeScript from 'typescript'
import { diagnostic } from './shared.js'

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
