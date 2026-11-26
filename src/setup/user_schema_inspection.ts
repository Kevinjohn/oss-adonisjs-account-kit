import { RuntimeException } from '@adonisjs/core/exceptions'
// Setup planning phase: static analysis of the UserSchema class the user model composes.
import { lstat, readFile } from 'node:fs/promises'
import { requireSafeSetupPath } from './safe_path.ts'
import type { SetupDiagnostic } from './types.ts'
import {
  isDirectClassBaseReference,
  isExactCall,
  hasUnsafeBindingReferences,
  getImportedBindingName,
  isTypeOnlyReference,
  parseSetupSource,
  walk,
  type SetupSource,
} from './ts_source.ts'
import { addSetupDiagnostic } from './shared.ts'
import { hasConventionalSetupImport } from './package_imports.ts'
import { hasUnsafeStaticMetadata, hasUnsupportedClassRuntime } from './model_inspection.ts'
import type * as TypeScript from 'typescript'

/** Resolve #database/schema to a UserSchema class that is safe to read column metadata from. */
export async function inspectUserSchema(
  root: string,
  manifestText: string | undefined,
  diagnostics: SetupDiagnostic[]
): Promise<{
  schemaClass: TypeScript.ClassDeclaration | null
  schemaSource: SetupSource | null
}> {
  const schemaPath = 'database/schema.ts'
  try {
    if (
      !hasConventionalSetupImport(
        manifestText,
        '#database/schema',
        '#database/*',
        './database/*.js',
        './database/schema.js'
      )
    )
      throw new RuntimeException('Setup cannot resolve #database/schema to the inspected schema')
    const path = await requireSafeSetupPath(root, schemaPath)
    const schemaStat = await lstat(path)
    if (!schemaStat.isFile())
      throw new RuntimeException(`Setup cannot inspect non-regular schema ${schemaPath}`)
    const parsed = await parseSetupSource(await readFile(path, 'utf8'))
    const base = getImportedBindingName(parsed, '@adonisjs/lucid/orm', 'BaseModel')
    const column = getImportedBindingName(parsed, '@adonisjs/lucid/orm', 'column')
    const matches = parsed.file.statements.filter(
      (node): node is TypeScript.ClassDeclaration =>
        parsed.ts.isClassDeclaration(node) &&
        node.name?.text === 'UserSchema' &&
        Boolean(
          node.modifiers?.some((modifier) => modifier.kind === parsed.ts.SyntaxKind.ExportKeyword)
        )
    )
    const candidate = matches.length === 1 ? matches[0] : null
    const directBase = candidate?.heritageClauses?.some(
      (clause) =>
        clause.token === parsed.ts.SyntaxKind.ExtendsKeyword &&
        clause.types.length === 1 &&
        parsed.ts.isIdentifier(clause.types[0].expression) &&
        clause.types[0].expression.text === base
    )
    const unsafeBase = Boolean(
      base &&
      hasUnsafeBindingReferences(
        parsed,
        base,
        () => false,
        (reference) => isDirectClassBaseReference(parsed, reference)
      )
    )
    const unsafeColumn =
      !column ||
      hasUnsafeBindingReferences(
        parsed,
        column,
        (call) =>
          parsed.ts.isDecorator(call.parent) &&
          ((parsed.ts.isIdentifier(call.expression) && call.expression.text === column) ||
            isExactCall(parsed, call, column, 'dateTime') ||
            isExactCall(parsed, call, column, 'date'))
      )
    let escaped = false
    if (candidate?.name)
      walk(parsed, (node) => {
        if (
          !parsed.ts.isIdentifier(node) ||
          node.text !== candidate.name!.text ||
          node === candidate.name ||
          isTypeOnlyReference(parsed, node)
        )
          return
        if (
          node.parent &&
          parsed.ts.isPropertyAccessExpression(node.parent) &&
          node.parent.expression === node &&
          node.parent.name.text === '$columns' &&
          node.parent.parent &&
          parsed.ts.isPropertyDeclaration(node.parent.parent) &&
          node.parent.parent.name.getText(parsed.file) === '$columns' &&
          node.parent.parent.parent === candidate
        )
          return
        escaped = true
      })
    const metadataUnsafe = hasUnsafeStaticMetadata(parsed, candidate, [
      'table',
      'connection',
      'primaryKey',
      'namingStrategy',
    ])
    if (
      directBase &&
      !unsafeBase &&
      !unsafeColumn &&
      !escaped &&
      !metadataUnsafe &&
      candidate &&
      !hasUnsupportedClassRuntime(parsed, candidate, true)
    ) {
      return { schemaClass: candidate, schemaSource: parsed }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      // planUserModel diagnoses the missing schema through unresolved inheritance.
    } else if (
      (error as Error).message === 'Setup cannot resolve #database/schema to the inspected schema'
    ) {
      addSetupDiagnostic(diagnostics, 'user.connection', (error as Error).message)
    } else throw error
  }
  return { schemaClass: null, schemaSource: null }
}
