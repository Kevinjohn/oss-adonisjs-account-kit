import type * as TypeScript from 'typescript'

export type SetupSource = { ts: typeof TypeScript; file: TypeScript.SourceFile; text: string }

/** TypeScript is a setup-time dependency. Other package entries do not load it. */
export async function parseSetupSource(text: string): Promise<SetupSource> {
  let ts: typeof TypeScript
  try {
    ts = await import('typescript')
  } catch {
    throw new Error('Setup requires TypeScript 5.9 or 6.0; install a supported version first')
  }
  const file = ts.createSourceFile(
    'application.ts',
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  )
  const diagnostics = ts.transpileModule(text, {
    fileName: 'application.ts',
    compilerOptions: { target: ts.ScriptTarget.Latest, module: ts.ModuleKind.ESNext },
    reportDiagnostics: true,
  }).diagnostics
  if (diagnostics?.some((item) => item.category === ts.DiagnosticCategory.Error))
    throw new Error('Setup cannot inspect invalid TypeScript source')
  return { ts, file, text }
}

export function importedName(source: SetupSource, module: string, imported: string): string | null {
  const { ts, file } = source
  const matches = file.statements
    .filter(ts.isImportDeclaration)
    .filter(
      (node) => ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === module
    )
    .flatMap((node) => {
      if (node.importClause?.isTypeOnly) return []
      const bindings = node.importClause?.namedBindings
      if (!bindings || !ts.isNamedImports(bindings)) return []
      return bindings.elements
        .filter(
          (element) =>
            !element.isTypeOnly && (element.propertyName?.text ?? element.name.text) === imported
        )
        .map((element) => element.name.text)
    })
  return matches.length === 1 ? matches[0] : null
}

export function defaultImportName(source: SetupSource, module: string): string | null {
  const { ts, file } = source
  const matches = file.statements
    .filter(ts.isImportDeclaration)
    .filter(
      (node) => ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === module
    )
    .map((node) => (node.importClause?.isTypeOnly ? undefined : node.importClause?.name?.text))
    .filter((name): name is string => Boolean(name))
  return matches.length === 1 ? matches[0] : null
}

export function directProperty(
  source: SetupSource,
  object: TypeScript.ObjectLiteralExpression,
  name: string
): TypeScript.PropertyAssignment | null {
  const { ts } = source
  if (object.properties.some((property) => ts.isSpreadAssignment(property))) return null
  const matches = object.properties.filter((property) => {
    if (!property.name) return false
    if (ts.isComputedPropertyName(property.name)) return false
    return property.name.getText(source.file).replace(/^['"]|['"]$/g, '') === name
  })
  return matches.length === 1 && ts.isPropertyAssignment(matches[0]) ? matches[0] : null
}

export function hasUnsafeObjectEntries(
  source: SetupSource,
  object: TypeScript.ObjectLiteralExpression
): boolean {
  const { ts } = source
  const names = new Set<string>()
  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property) || ts.isComputedPropertyName(property.name)) return true
    const name = property.name.getText(source.file).replace(/^['"]|['"]$/g, '')
    if (names.has(name)) return true
    names.add(name)
  }
  return false
}

export function exactCall(
  source: SetupSource,
  node: TypeScript.Node,
  receiver: string,
  method: string
): node is TypeScript.CallExpression {
  const { ts } = source
  return (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === receiver &&
    node.expression.name.text === method
  )
}

export function defaultExpression(source: SetupSource): {
  expression: TypeScript.Expression
  declaration: TypeScript.VariableDeclaration | null
  exportAssignment: TypeScript.ExportAssignment
} | null {
  const { ts, file } = source
  const exports = file.statements.filter(ts.isExportAssignment)
  if (exports.length !== 1 || exports[0].isExportEquals) return null
  const expression = exports[0].expression
  let declaration: TypeScript.VariableDeclaration | null = null
  let initializer: TypeScript.Expression = expression
  if (ts.isIdentifier(expression)) {
    const matching = file.statements
      .filter(ts.isVariableStatement)
      .flatMap((statement) => [...statement.declarationList.declarations])
      .filter((item) => ts.isIdentifier(item.name) && item.name.text === expression.text)
    if (matching.length !== 1 || !matching[0].initializer) return null
    declaration = matching[0]
    initializer = matching[0].initializer!
  }
  return { expression: initializer, declaration, exportAssignment: exports[0] }
}

export function exportedObject(
  source: SetupSource,
  allowedFactory?: string
): TypeScript.ObjectLiteralExpression | null {
  const target = defaultExpression(source)
  if (!target) return null
  let expression = target.expression
  if (source.ts.isCallExpression(expression)) {
    if (
      !source.ts.isIdentifier(expression.expression) ||
      (allowedFactory && expression.expression.text !== allowedFactory) ||
      expression.arguments.length !== 1
    )
      return null
    expression = expression.arguments[0]
  }
  return source.ts.isObjectLiteralExpression(expression) ? expression : null
}

export function topLevelConfig(
  source: SetupSource,
  defineConfigName: string
): {
  object: TypeScript.ObjectLiteralExpression
  declaration: TypeScript.VariableDeclaration | null
  exportAssignment: TypeScript.ExportAssignment
} | null {
  const target = defaultExpression(source)
  const initializer = target?.expression
  if (!target || !initializer || !source.ts.isCallExpression(initializer)) return null
  if (!source.ts.isIdentifier(initializer.expression)) return null
  if (initializer.expression.text !== defineConfigName || initializer.arguments.length !== 1)
    return null
  const object = initializer.arguments[0]
  return source.ts.isObjectLiteralExpression(object)
    ? { object, declaration: target.declaration, exportAssignment: target.exportAssignment }
    : null
}

export function walk(source: SetupSource, visitor: (node: TypeScript.Node) => void): void {
  const visit = (node: TypeScript.Node) => {
    visitor(node)
    source.ts.forEachChild(node, visit)
  }
  visit(source.file)
}
