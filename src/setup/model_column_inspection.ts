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
  for (const member of selected.members) {
    if (!ts.isPropertyDeclaration(member)) continue
    const decorators = member.modifiers?.filter(ts.isDecorator) ?? []
    if (!decorators.length) continue
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
