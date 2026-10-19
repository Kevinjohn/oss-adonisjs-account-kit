import type { SetupChoices, SetupDiagnostic, SetupFileChange, SetupInspection } from './types.js'
import { resolveSelectedEnvironment } from './selected_environment.js'
import {
  defaultExpression,
  defaultImportName,
  directProperty,
  exactCall,
  exportedObject,
  hasUnsafeObjectEntries,
  importedName,
  parseSetupSource,
  safeEnvGetter,
  topLevelConfig,
  walk,
} from './ts_source.js'
import type * as TypeScript from 'typescript'
import { diagnostic } from './shared.js'

export const sessionImport =
  "// account-kit:session-import:start\nimport { protectManagedSessionConfig } from 'adonisjs-account-kit/http'\n// account-kit:session-import:end\n"

export const selectionStart = '// account-kit:session-selection:start\n'

export const selectionEnd = '\n// account-kit:session-selection:end\n'

export const exportStart = '// account-kit:session-export:start\n'

export const exportEnd = '// account-kit:session-export:end\n'

export interface NativeSessionConfiguration {
  configStart: number
  exportStartIndex: number
  originalStore: string
  originalSelection: string
  storeStart: number
  allowedStores: Array<{ name: string; kind: 'database' | 'memory' }>
  selectedName: string | null
  selected: { name: string; kind: 'database' | 'memory' } | null
}

export async function nativeSessionConfiguration(
  text: string,
  root: string
): Promise<NativeSessionConfiguration | null> {
  const source = await parseSetupSource(text)
  const { ts, file } = source
  const defineConfigName = importedName(source, '@adonisjs/session', 'defineConfig')
  const storesName = importedName(source, '@adonisjs/session', 'stores')
  if (!defineConfigName || !storesName) return null
  const target = topLevelConfig(source, defineConfigName)
  if (!target?.declaration || hasUnsafeObjectEntries(source, target.object)) return null
  const declaration = target.declaration
  if (!ts.isIdentifier(declaration.name) || declaration.name.text !== 'sessionConfig') return null
  if (!ts.isVariableStatement(declaration.parent.parent)) return null
  if (!(declaration.parent.flags & ts.NodeFlags.Const)) return null
  const store = directProperty(source, target.object, 'store')
  const stores = directProperty(source, target.object, 'stores')
  if (!store || !stores || !ts.isObjectLiteralExpression(stores.initializer)) return null
  if (hasUnsafeObjectEntries(source, stores.initializer)) return null
  const allowedStores: NativeSessionConfiguration['allowedStores'] = []
  for (const property of stores.initializer.properties) {
    if (!ts.isPropertyAssignment(property)) return null
    const name =
      ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)
        ? property.name.text
        : null
    if (!name) return null
    for (const kind of ['database', 'memory'] as const) {
      if (exactCall(source, property.initializer, storesName, kind))
        allowedStores.push({ name, kind })
    }
  }
  let selectedName: string | null = null
  if (ts.isStringLiteral(store.initializer)) selectedName = store.initializer.text
  else {
    const envBinding = defaultImportName(source, '#start/env')
    if (
      !envBinding ||
      !exactCall(source, store.initializer, envBinding, 'get') ||
      !safeEnvGetter(source, envBinding)
    )
      return null
    const args = store.initializer.arguments
    if (
      args.length < 1 ||
      args.length > 2 ||
      !ts.isStringLiteral(args[0]) ||
      !/^[A-Z][A-Z0-9_]*$/.test(args[0].text) ||
      (args.length === 2 && !ts.isStringLiteral(args[1]))
    )
      return null
    selectedName =
      (await resolveSelectedEnvironment(root, args[0].text)) ??
      (args.length === 2 ? (args[1] as TypeScript.StringLiteral).text : null)
  }
  let unsafe = false
  walk(source, (node) => {
    if (!ts.isIdentifier(node)) return
    if (node.text === storesName) {
      if (
        ts.isImportSpecifier(node.parent) ||
        (ts.isPropertyAssignment(node.parent) && node.parent.name === node)
      )
        return
      const property = node.parent
      const call = property.parent
      if (
        ts.isPropertyAccessExpression(property) &&
        property.expression === node &&
        ts.isCallExpression(call) &&
        call.expression === property &&
        call.getStart(file) > stores.initializer.getStart(file) &&
        call.getEnd() < stores.initializer.getEnd()
      )
        return
      unsafe = true
    }
    if (
      node.text === 'sessionConfig' &&
      node !== declaration.name &&
      node !== target.exportAssignment.expression
    )
      unsafe = true
  })
  if (unsafe) return null
  const selected = allowedStores.find(({ name }) => name === selectedName) ?? null
  return {
    configStart: declaration.parent.parent.getStart(file),
    exportStartIndex: target.exportAssignment.getStart(file),
    originalStore: store.initializer.getText(file),
    originalSelection: store.getText(file),
    storeStart: store.getStart(file),
    allowedStores,
    selectedName,
    selected,
  }
}

/** A diagnostic-only classifier; it never authorizes automatic attestation. */
export async function selectedSessionDiagnostic(
  text: string,
  root: string
): Promise<{
  name: string | null
  kind: string | null
} | null> {
  const source = await parseSetupSource(text)
  const object = exportedObject(
    source,
    importedName(source, '@adonisjs/session', 'defineConfig') ?? undefined
  )
  const store = object && directProperty(source, object, 'store')
  const stores = object && directProperty(source, object, 'stores')
  if (!store || !stores || !source.ts.isObjectLiteralExpression(stores.initializer)) return null
  let name: string | null = null
  if (source.ts.isStringLiteral(store.initializer)) name = store.initializer.text
  else if (
    defaultImportName(source, '#start/env') &&
    safeEnvGetter(source, defaultImportName(source, '#start/env')!) &&
    exactCall(source, store.initializer, defaultImportName(source, '#start/env')!, 'get') &&
    store.initializer.arguments.length >= 1 &&
    source.ts.isStringLiteral(store.initializer.arguments[0])
  )
    name = await resolveSelectedEnvironment(root, store.initializer.arguments[0].text)
  if (!name) return { name: null, kind: null }
  const selected = directProperty(source, stores.initializer, name)
  const initializer = selected?.initializer
  const kind =
    initializer &&
    source.ts.isCallExpression(initializer) &&
    source.ts.isPropertyAccessExpression(initializer.expression) &&
    source.ts.isIdentifier(initializer.expression.expression) &&
    initializer.expression.expression.text === 'stores'
      ? initializer.expression.name.text
      : null
  return { name, kind }
}

export function renderManagedSessionConfig(
  source: string,
  inspected: NativeSessionConfiguration
): string {
  const {
    configStart,
    exportStartIndex,
    originalStore,
    originalSelection,
    storeStart,
    allowedStores,
  } = inspected
  const selector = 'accountKitSelectedSessionStore'
  const selection = `${selectionStart}const ${selector} = ${originalStore}${selectionEnd}`
  const verify = allowedStores
    .map(({ name, kind }) =>
      kind === 'memory'
        ? `(${selector} === ${JSON.stringify(name)} && process.env.NODE_ENV !== 'production')`
        : `${selector} === ${JSON.stringify(name)}`
    )
    .join(' || ')
  const wrappedExport = `${exportStart}export default protectManagedSessionConfig(sessionConfig, {
  verifyStore: (actual) =>
    (${verify}) &&
    actual !== null &&
    typeof actual === 'object' &&
    ['read', 'write', 'destroy', 'touch'].every(
      (method) => typeof (actual as Record<string, unknown>)[method] === 'function'
    ),
})
${exportEnd}`
  return (
    sessionImport +
    source.slice(0, configStart) +
    selection +
    source.slice(configStart, storeStart) +
    `store: ${selector}` +
    source.slice(storeStart + originalSelection.length, exportStartIndex) +
    wrappedExport +
    source.slice(exportStartIndex + 'export default sessionConfig'.length)
  )
}

export async function unwrapManagedSessionConfig(
  source: string,
  root: string
): Promise<string | null> {
  if (!source.startsWith(sessionImport)) return null
  const selectionMatch = source.match(
    /\/\/ account-kit:session-selection:start\nconst accountKitSelectedSessionStore = ([\s\S]*?)\n\/\/ account-kit:session-selection:end\n/
  )
  const exportMatch = source.match(
    /\/\/ account-kit:session-export:start\n[\s\S]*?\/\/ account-kit:session-export:end\n/
  )
  if (!selectionMatch || !exportMatch) return null
  const base = source
    .slice(sessionImport.length)
    .replace(selectionMatch[0], '')
    .replace('store: accountKitSelectedSessionStore', `store: ${selectionMatch[1]}`)
    .replace(exportMatch[0], 'export default sessionConfig')
  const inspected = await nativeSessionConfiguration(base, root)
  return inspected && renderManagedSessionConfig(base, inspected) === source ? base : null
}

export async function planSessionConfigIntegration(
  changes: SetupFileChange[],
  state: SetupInspection,
  choices: SetupChoices,
  diagnostics: SetupDiagnostic[]
): Promise<void> {
  const path = 'config/session.ts'
  const previous = state.files[path]
  if (!previous) return
  const wantsManagedSession =
    choices.managed.length > 0 && choices.authentication?.strategy === 'session'
  const wasManaged = previous.includes('account-kit:session-import:start')
  const base = wasManaged ? await unwrapManagedSessionConfig(previous, state.root) : previous
  if (base === null) {
    diagnostic(
      diagnostics,
      path,
      'The managed session integration was edited; restore its marked block or reconcile it manually before setup'
    )
    return
  }
  if (!wantsManagedSession && !wasManaged) return
  const parsed = await parseSetupSource(previous)
  const existingWrapper = defaultExpression(parsed)
  const wrapperBinding = importedName(
    parsed,
    'adonisjs-account-kit/http',
    'protectManagedSessionConfig'
  )
  if (
    !wasManaged &&
    wrapperBinding &&
    existingWrapper &&
    parsed.ts.isCallExpression(existingWrapper.expression) &&
    parsed.ts.isIdentifier(existingWrapper.expression.expression) &&
    existingWrapper.expression.expression.text === wrapperBinding
  ) {
    diagnostic(
      diagnostics,
      path,
      'Verify the existing application-owned session protection wrapper before enabling managed session routes',
      'action'
    )
    return
  }
  let inspected: NativeSessionConfiguration | null = null
  if (wantsManagedSession) {
    try {
      inspected = await nativeSessionConfiguration(base, state.root)
    } catch {
      diagnostic(
        diagnostics,
        path,
        'Inspect the selected session environment assignment and file path; only a direct native store name is supported'
      )
      return
    }
  }
  if (wantsManagedSession && !inspected?.selected) {
    diagnostic(
      diagnostics,
      path,
      'The selected session factory must be an inspected native database or development memory store; custom or unresolved selections need a truthful application-owned protectManagedSessionConfig wrapper'
    )
    return
  }
  const content =
    wantsManagedSession && inspected ? renderManagedSessionConfig(base, inspected) : base
  if (content === null) {
    diagnostic(
      diagnostics,
      path,
      'Use a conventional const sessionConfig = defineConfig(...) and export default sessionConfig, or wire protectManagedSessionConfig manually before managed session activation'
    )
    return
  }
  changes.push({
    path,
    action: previous === content ? 'unchanged' : 'update',
    expected: previous,
    content,
    reason: wantsManagedSession
      ? 'Verify the selected server-side session store before issuing managed credentials'
      : 'Retire the setup-owned managed session verification wrapper',
  })
}
