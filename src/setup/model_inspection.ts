import {
  directProperty,
  exactCall,
  hasUnsafeObjectEntries,
  hasUnsafeBindingReferences,
  importedName,
  unwrapStaticExpression,
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

/** Keep automatic model inspection within declarations whose class evaluation is understood. */
export function unsupportedClassRuntime(
  source: SetupSource,
  selected: TypeScript.ClassDeclaration,
  schema: boolean
): boolean {
  const { ts } = source
  if (ts.canHaveDecorators(selected) && ts.getDecorators(selected)?.length) return true
  const provider = importedName(source, '@adonisjs/auth/access_tokens', 'DbAccessTokensProvider')
  for (const member of selected.members) {
    if (ts.isConstructorDeclaration(member) || ts.isClassStaticBlockDeclaration(member)) return true
    const modifiers = ts.canHaveModifiers(member) ? ts.getModifiers(member) : undefined
    const decorators = ts.canHaveDecorators(member) ? (ts.getDecorators(member) ?? []) : []
    if (decorators.length && !ts.isPropertyDeclaration(member)) return true
    const staticMember = modifiers?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword
    )
    if (!staticMember) {
      if (
        (ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member)) &&
        ts.isIdentifier(member.name) &&
        member.name.text === 'id'
      )
        return true
      if (
        ts.isPropertyDeclaration(member) &&
        member.initializer &&
        !(
          schema &&
          ts.isIdentifier(member.name) &&
          member.name.text === '$columns' &&
          ts.isPropertyAccessExpression(member.initializer) &&
          ts.isIdentifier(member.initializer.expression) &&
          member.initializer.expression.text === selected.name?.text &&
          member.initializer.name.text === '$columns'
        )
      )
        return true
      continue
    }
    if (!ts.isPropertyDeclaration(member) || !ts.isIdentifier(member.name)) return true
    const name = member.name.text
    if (['table', 'connection', 'primaryKey', 'namingStrategy'].includes(name)) continue
    if (schema && name === '$columns') {
      const initializer = member.initializer && unwrapStaticExpression(source, member.initializer)
      if (
        !initializer ||
        !ts.isArrayLiteralExpression(initializer) ||
        initializer.elements.some((element) => !ts.isStringLiteral(element))
      )
        return true
      continue
    }
    if (!schema && name === 'accessTokens') {
      const initializer = member.initializer && unwrapStaticExpression(source, member.initializer)
      if (
        initializer &&
        (ts.isIdentifier(initializer) ||
          (ts.isObjectLiteralExpression(initializer) && initializer.properties.length === 0))
      )
        continue
      if (
        initializer &&
        provider &&
        exactCall(source, initializer, provider, 'forModel') &&
        initializer.arguments.length === 1 &&
        ts.isIdentifier(initializer.arguments[0]) &&
        initializer.arguments[0].text === selected.name?.text
      )
        continue
    }
    return true
  }
  return false
}

/** Static property declarations of a class with the given name. */
export function staticMembers(
  source: SetupSource,
  selected: TypeScript.ClassDeclaration | null | undefined,
  name: string
): TypeScript.ClassElement[] {
  const { ts } = source
  return (
    selected?.members.filter(
      (member) =>
        ts.isPropertyDeclaration(member) &&
        Boolean(
          member.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword)
        ) &&
        (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name)) &&
        member.name.text === name
    ) ?? []
  )
}

/** Static blocks, computed or accessor-style static metadata, or duplicated metadata need review. */
export function hasUnsafeStaticMetadata(
  source: SetupSource,
  selected: TypeScript.ClassDeclaration | null | undefined,
  metadataNames: readonly string[]
): boolean {
  const { ts } = source
  return Boolean(
    selected?.members.some((member) => {
      if (ts.isClassStaticBlockDeclaration(member)) return true
      if (
        !ts.canHaveModifiers(member) ||
        !ts.getModifiers(member)?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword)
      )
        return false
      const name = member.name
      if (!name) return false
      if (ts.isComputedPropertyName(name)) return true
      return (
        !ts.isPropertyDeclaration(member) &&
        (ts.isIdentifier(name) || ts.isStringLiteral(name)) &&
        metadataNames.includes(name.text)
      )
    }) || metadataNames.some((name) => staticMembers(source, selected, name).length > 1)
  )
}
