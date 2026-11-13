import type * as TypeScript from 'typescript'
import { lazyImportPath, type SetupSource } from './ts_source.js'

/**
 * Reads one named property of an object literal, or returns null when the caller cannot read it
 * statically. Configure and setup apply different rules to spreads and unusual keys.
 */
export type PropertyReader = (
  object: TypeScript.ObjectLiteralExpression,
  name: string
) => TypeScript.ObjectLiteralElementLike | null | undefined

/** One providers entry: `() => import('x')`, or an object whose `file` property is that import. */
export type ProviderEntry = {
  node: TypeScript.Expression
  isObject: boolean
  /** The statically imported module, or null when the entry is not a lazy import. */
  path: string | null
}

export type ProvidersInspection =
  | { status: 'absent' }
  | { status: 'not-assignment' }
  | { status: 'not-array' }
  | { status: 'array'; array: TypeScript.ArrayLiteralExpression; entries: ProviderEntry[] }

/** Find the `providers` array of an RC config object and the module each entry imports. */
export function inspectProviders(
  source: SetupSource,
  config: TypeScript.ObjectLiteralExpression,
  read: { config: PropertyReader; entry: PropertyReader }
): ProvidersInspection {
  const { ts } = source
  const property = read.config(config, 'providers')
  if (!property) return { status: 'absent' }
  if (!ts.isPropertyAssignment(property)) return { status: 'not-assignment' }
  const array = property.initializer
  if (!ts.isArrayLiteralExpression(array)) return { status: 'not-array' }
  const entries = array.elements.map((node) => {
    const isObject = ts.isObjectLiteralExpression(node)
    let loader: TypeScript.Node | undefined = node
    if (isObject) {
      const file = read.entry(node, 'file')
      loader = file && ts.isPropertyAssignment(file) ? file.initializer : undefined
    }
    return { node, isObject, path: loader ? lazyImportPath(source, loader) : null }
  })
  return { status: 'array', array, entries }
}
