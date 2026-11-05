import {
  directProperty,
  exactCall,
  hasUnsafeObjectEntries,
  hasUnsafeBindingReferences,
  importedName,
  type SetupSource,
} from './ts_source.js'
import type * as TypeScript from 'typescript'
export type InspectedColumn = {
  primary: boolean
  physical: string
  declaration: TypeScript.PropertyDeclaration
}

const nonColumnDecorators = [
  'belongsTo',
  'computed',
  'hasMany',
  'hasManyThrough',
  'hasOne',
  'manyToMany',
] as const

function isNonColumnDecorator(
  ts: SetupSource['ts'],
  decorator: TypeScript.Decorator,
  bindings: Set<string>
): boolean {
  const call = decorator.expression
  return (
    ts.isCallExpression(call) &&
    ts.isIdentifier(call.expression) &&
    bindings.has(call.expression.text)
  )
}

/** Inspect only the Lucid column decorators that determine the runtime primary mapping. */
export function classColumns(
  source: SetupSource,
  selected: TypeScript.ClassDeclaration
): {
  columns: Map<string, InspectedColumn>
  unsafe: boolean
} {
  const { ts } = source
  const binding = importedName(source, '@adonisjs/lucid/orm', 'column')
  const columns = new Map<string, InspectedColumn>()
  let unsafe = Boolean(
    binding &&
    hasUnsafeBindingReferences(
      source,
      binding,
      (call) =>
        ts.isDecorator(call.parent) &&
        ((ts.isIdentifier(call.expression) && call.expression.text === binding) ||
          exactCall(source, call, binding, 'dateTime') ||
          exactCall(source, call, binding, 'date'))
    )
  )
  const nonColumnBindings = new Set(
    nonColumnDecorators
      .map((name) => importedName(source, '@adonisjs/lucid/orm', name))
      .filter((name): name is string => name !== null)
  )
  for (const member of selected.members) {
    if (!ts.isPropertyDeclaration(member)) continue
    const decorators = member.modifiers?.filter(ts.isDecorator) ?? []
    if (!decorators.length) continue
    // Relations and computed properties have no column, so they cannot change the mapping.
    if (decorators.length === 1 && isNonColumnDecorator(ts, decorators[0], nonColumnBindings))
      continue
    if (!ts.isIdentifier(member.name) || decorators.length !== 1 || !binding) {
      unsafe = true
      continue
    }
    const call = decorators[0].expression
    if (
      !ts.isCallExpression(call) ||
      !(
        (ts.isIdentifier(call.expression) && call.expression.text === binding) ||
        exactCall(source, call, binding, 'dateTime') ||
        exactCall(source, call, binding, 'date')
      ) ||
      call.arguments.length > 1
    ) {
      unsafe = true
      continue
    }
    const options = call.arguments[0]
    if (
      options &&
      (!ts.isObjectLiteralExpression(options) || hasUnsafeObjectEntries(source, options))
    ) {
      unsafe = true
      continue
    }
    const primary =
      options && ts.isObjectLiteralExpression(options)
        ? directProperty(source, options, 'isPrimary')?.initializer
        : undefined
    const columnName =
      options && ts.isObjectLiteralExpression(options)
        ? directProperty(source, options, 'columnName')?.initializer
        : undefined
    if (
      (primary &&
        primary.kind !== ts.SyntaxKind.TrueKeyword &&
        primary.kind !== ts.SyntaxKind.FalseKeyword) ||
      (columnName && !ts.isStringLiteral(columnName)) ||
      columns.has(member.name.text)
    ) {
      unsafe = true
      continue
    }
    columns.set(member.name.text, {
      primary: primary?.kind === ts.SyntaxKind.TrueKeyword,
      physical: columnName && ts.isStringLiteral(columnName) ? columnName.text : member.name.text,
      declaration: member,
    })
  }
  return { columns, unsafe }
}
