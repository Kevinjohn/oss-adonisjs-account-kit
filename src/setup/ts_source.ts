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

/** Multiple runtime views of a module make a selected import's provenance ambiguous. */
export function hasAmbiguousRuntimeModuleImports(source: SetupSource, module: string): boolean {
  const { ts } = source
  let dynamicExposure = false
  walk(source, (node) => {
    if (!ts.isCallExpression(node)) return
    const isImport = node.expression.kind === ts.SyntaxKind.ImportKeyword
    const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require'
    if (!isImport && !isRequire) return
    const specifier = node.arguments[0]
    if (
      !specifier ||
      (!ts.isStringLiteral(specifier) && !ts.isNoSubstitutionTemplateLiteral(specifier))
    ) {
      dynamicExposure = true
    } else if (specifier.text === module) {
      dynamicExposure = true
    }
  })
  if (dynamicExposure) return true
  const bindings = source.file.statements
    .filter(ts.isImportDeclaration)
    .filter(
      (node) =>
        ts.isStringLiteral(node.moduleSpecifier) &&
        node.moduleSpecifier.text === module &&
        !node.importClause?.isTypeOnly
    )
    .map((node) => node.importClause)
    .filter((clause): clause is TypeScript.ImportClause => Boolean(clause))
    .filter(
      (clause) =>
        clause.name ||
        (clause.namedBindings &&
          (ts.isNamespaceImport(clause.namedBindings) ||
            clause.namedBindings.elements.some((element) => !element.isTypeOnly)))
    )
  if (bindings.length > 1) return true
  const clause = bindings[0]
  if (!clause) return false
  const named = clause.namedBindings
  if (named && ts.isNamespaceImport(named)) return true
  if (!named || !ts.isNamedImports(named)) return false
  const exports = named.elements
    .filter((element) => !element.isTypeOnly)
    .map((element) => element.propertyName?.text ?? element.name.text)
  if (clause.name && exports.length) return true
  return new Set(exports).size !== exports.length
}

export function importedName(source: SetupSource, module: string, imported: string): string | null {
  if (hasAmbiguousRuntimeModuleImports(source, module)) return null
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
  if (hasAmbiguousRuntimeModuleImports(source, module)) return null
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
  if (hasUnsafeObjectEntries(source, object)) return null
  const matches = object.properties.filter((property) => {
    if (!property.name) return false
    return (
      (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) &&
      property.name.text === name
    )
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
    if (
      !ts.isPropertyAssignment(property) ||
      !(ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
    )
      return true
    const name = property.name.text
    if (names.has(name)) return true
    names.add(name)
  }
  return false
}

export function directObject(
  source: SetupSource,
  node: TypeScript.Node
): TypeScript.ObjectLiteralExpression | null {
  return source.ts.isObjectLiteralExpression(node) && !hasUnsafeObjectEntries(source, node)
    ? node
    : null
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

/** Reject uses of an imported binding outside the exact read-only calls we inspect. */
export function hasUnsafeBindingReferences(
  source: SetupSource,
  binding: string,
  allowedCall: (call: TypeScript.CallExpression) => boolean,
  allowedReference: (reference: TypeScript.Identifier) => boolean = () => false
): boolean {
  const { ts } = source
  let unsafe = false
  walk(source, (node) => {
    if (!ts.isIdentifier(node) || node.text !== binding) return
    if (isTypeOnlyReference(source, node)) return
    const parent = node.parent
    if (
      (ts.isImportClause(parent) && parent.name === node) ||
      (ts.isImportSpecifier(parent) && (parent.name === node || parent.propertyName === node)) ||
      (ts.isNamespaceImport(parent) && parent.name === node) ||
      (ts.isPropertyAssignment(parent) && parent.name === node) ||
      (ts.isPropertyAccessExpression(parent) && parent.name === node)
    )
      return
    if (allowedReference(node)) return
    const member =
      ts.isPropertyAccessExpression(parent) && parent.expression === node ? parent : null
    const call =
      member && ts.isCallExpression(member.parent) && member.parent.expression === member
        ? member.parent
        : ts.isCallExpression(parent) && parent.expression === node
          ? parent
          : null
    if (!call || !allowedCall(call)) unsafe = true
  })
  return unsafe
}

/** A type query references a value's type but never reads that value at runtime. */
export function isTypeOnlyReference(source: SetupSource, node: TypeScript.Node): boolean {
  let child = node
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (
      source.ts.isExpressionWithTypeArguments(parent) &&
      child === parent.expression &&
      source.ts.isHeritageClause(parent.parent) &&
      parent.parent.token === source.ts.SyntaxKind.ExtendsKeyword &&
      (source.ts.isClassDeclaration(parent.parent.parent) ||
        source.ts.isClassExpression(parent.parent.parent))
    )
      return false
    if (source.ts.isTypeNode(parent)) return true
    if (source.ts.isExpression(parent) || source.ts.isStatement(parent)) return false
    child = parent
  }
  return false
}

export function safeEnvGetter(source: SetupSource, binding: string): boolean {
  return !hasUnsafeBindingReferences(source, binding, (call) =>
    exactCall(source, call, binding, 'get')
  )
}

/** Remove syntax-only wrappers before classifying an inspected expression. */
export function unwrapStaticExpression(
  source: SetupSource,
  expression: TypeScript.Expression
): TypeScript.Expression {
  const { ts } = source
  while (
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isSatisfiesExpression(expression) ||
    ts.isNonNullExpression(expression) ||
    ts.isTypeAssertionExpression(expression)
  )
    expression = expression.expression
  return expression
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
    let unsafe = false
    walk(source, (node) => {
      if (
        ts.isIdentifier(node) &&
        node.text === expression.text &&
        node !== declaration?.name &&
        node !== expression &&
        !isTypeOnlyReference(source, node) &&
        !(ts.isPropertyAssignment(node.parent) && node.parent.name === node)
      )
        unsafe = true
    })
    if (unsafe) return null
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
      !allowedFactory ||
      !source.ts.isIdentifier(expression.expression) ||
      expression.expression.text !== allowedFactory ||
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
