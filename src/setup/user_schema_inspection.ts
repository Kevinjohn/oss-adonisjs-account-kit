// Setup planning phase: static analysis of the UserSchema class the user model composes.
import { lstat, readFile } from 'node:fs/promises'
import { safeSetupPath } from './safe_path.js'
import type { SetupDiagnostic } from './types.js'
import {
  directClassBaseHeritage,
  exactCall,
  hasUnsafeBindingReferences,
  importedName,
  isTypeOnlyReference,
  parseSetupSource,
  walk,
  type SetupSource,
} from './ts_source.js'
import { diagnostic } from './shared.js'
import {
  conventionalSetupImport,
  hasUnsafeStaticMetadata,
  unsupportedClassRuntime,
} from './model_inspection.js'
import type * as TypeScript from 'typescript'

/** Resolve #database/schema to a UserSchema class that is safe to read column metadata from. */
export async function inspectUserSchema(
  root: string,
  diagnostics: SetupDiagnostic[]
): Promise<{
  schemaClass: TypeScript.ClassDeclaration | null
  schemaSource: SetupSource | null
}> {
  const schemaPath = 'database/schema.ts'
  try {
    if (
      !(await conventionalSetupImport(
        root,
        '#database/schema',
        '#database/*',
        './database/*.js',
        './database/schema.js'
      ))
    )
      throw new Error('Setup cannot resolve #database/schema to the inspected schema')
    const path = await safeSetupPath(root, schemaPath)
    const schemaStat = await lstat(path)
    if (!schemaStat.isFile())
      throw new Error(`Setup cannot inspect non-regular schema ${schemaPath}`)
    const parsed = await parseSetupSource(await readFile(path, 'utf8'))
    const base = importedName(parsed, '@adonisjs/lucid/orm', 'BaseModel')
    const column = importedName(parsed, '@adonisjs/lucid/orm', 'column')
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
        (reference) => directClassBaseHeritage(parsed, reference)
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
            exactCall(parsed, call, column, 'dateTime') ||
            exactCall(parsed, call, column, 'date'))
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
      !unsupportedClassRuntime(parsed, candidate, true)
    ) {
      return { schemaClass: candidate, schemaSource: parsed }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      // planUserModel diagnoses the missing schema through unresolved inheritance.
    } else if (
      (error as Error).message === 'Setup cannot resolve #database/schema to the inspected schema'
    ) {
      diagnostic(diagnostics, 'user.connection', (error as Error).message)
    } else throw error
  }
  return { schemaClass: null, schemaSource: null }
}
