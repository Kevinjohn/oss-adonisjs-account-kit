import type { SetupDiagnostic, SetupFileChange, SetupInspection } from './types.js'
import {
  defaultExpression,
  directProperty,
  importedName,
  parseSetupSource,
  type SetupSource,
} from './ts_source.js'
import type * as TypeScript from 'typescript'
import { inspectProviders } from './providers_inspection.js'
import { diagnostic } from './shared.js'

export async function planArrayImports(
  changes: SetupFileChange[],
  state: SetupInspection,
  diagnostics: SetupDiagnostic[],
  path: string,
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
  // Setup reads only plain objects, so a spread or a duplicate key leaves the property unread.
  const read = (entry: TypeScript.ObjectLiteralExpression, name: string) =>
    directProperty(source!, entry, name)
  const providers =
    source && object && inspectProviders(source, object, { config: read, entry: read })
  if (!previous || !source || !providers || providers.status !== 'array') {
    diagnostic(
      diagnostics,
      path,
      `Expected a default-exported providers array in ${path}; configure these imports manually before activation`
    )
    return
  }
  const present = new Set(providers.entries.map((entry) => entry.path))
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
  const at = providers.array.getStart(source.file) + 1
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
