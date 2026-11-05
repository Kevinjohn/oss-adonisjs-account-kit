// Identity and SQLite boundary shared by the demo producers and destructive recorders.
import { lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import * as ts from 'typescript'
import {
  attestStarter,
  readStarter,
  verifySnapshot,
  type StarterSnapshot,
} from './starter_contract.js'

export type DemoRole = 'feature-recording' | 'setup-recording'

type DemoIdentity = {
  version: 1
  role: DemoRole
  root: string
  starter: StarterSnapshot
}

export type ValidatedDemo = {
  root: string
  databasePath: string
  childEnv: NodeJS.ProcessEnv
}

const markerName = '.account-kit-demo.json'

function isWithin(root: string, target: string) {
  const path = relative(root, target)
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
}

function assertRegularFile(path: string, description: string) {
  let stat
  try {
    stat = lstatSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      throw new Error(`missing ${description}: ${path}`, { cause: error })
    throw error
  }
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error(`${description} must be a regular file: ${path}`)
}

function assertDirectory(path: string, description: string) {
  let stat
  try {
    stat = lstatSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      throw new Error(`missing ${description}: ${path}`, { cause: error })
    throw error
  }
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error(`${description} must be a real directory: ${path}`)
}

function sqlitePath(root: string) {
  const tmp = join(root, 'tmp')
  assertDirectory(tmp, 'demo temporary directory')
  const canonicalTmp = realpathSync(tmp)
  if (!isWithin(root, canonicalTmp))
    throw new Error('demo temporary directory escapes its generated root')
  const databasePath = join(canonicalTmp, 'db.sqlite3')
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    const checkedPath = databasePath + suffix
    try {
      const stat = lstatSync(checkedPath)
      if (!stat.isFile() || stat.isSymbolicLink())
        throw new Error('demo SQLite database must be a regular file inside its generated root')
      if (stat.nlink !== 1)
        throw new Error('demo SQLite database must not be hard-linked outside its generated root')
      const physical = realpathSync(checkedPath)
      if (!isWithin(root, physical))
        throw new Error('demo SQLite database escapes its generated root')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  return databasePath
}

function safeStaticValue(expression: ts.Expression): boolean {
  if (
    ts.isStringLiteral(expression) ||
    ts.isNumericLiteral(expression) ||
    ts.isNoSubstitutionTemplateLiteral(expression) ||
    expression.kind === ts.SyntaxKind.TrueKeyword ||
    expression.kind === ts.SyntaxKind.FalseKeyword ||
    expression.kind === ts.SyntaxKind.NullKeyword
  )
    return true
  if (ts.isArrayLiteralExpression(expression))
    return expression.elements.every(
      (element) => !ts.isSpreadElement(element) && safeStaticValue(element)
    )
  if (
    ts.isCallExpression(expression) &&
    ts.isPropertyAccessExpression(expression.expression) &&
    ts.isIdentifier(expression.expression.expression) &&
    expression.expression.expression.text === 'app' &&
    expression.expression.name.text === 'tmpPath' &&
    expression.arguments.length === 1 &&
    ts.isStringLiteral(expression.arguments[0]) &&
    expression.arguments[0].text === 'db.sqlite3'
  )
    return true
  if (!ts.isObjectLiteralExpression(expression)) return false

  const names = new Set<string>()
  for (const member of expression.properties) {
    if (!ts.isPropertyAssignment(member) || !ts.isIdentifier(member.name)) return false
    if (names.has(member.name.text) || !safeStaticValue(member.initializer)) return false
    names.add(member.name.text)
  }
  return true
}

function properties(object: ts.ObjectLiteralExpression) {
  const found = new Map<string, ts.Expression>()
  for (const member of object.properties) {
    if (!ts.isPropertyAssignment(member) || !ts.isIdentifier(member.name))
      throw new Error('generated database config must use static named properties')
    if (found.has(member.name.text))
      throw new Error(`generated database config repeats ${member.name.text}`)
    if (!safeStaticValue(member.initializer))
      throw new Error(`generated database config contains executable ${member.name.text} data`)
    found.set(member.name.text, member.initializer)
  }
  return found
}

function stringValue(node: ts.Expression | undefined) {
  return node && ts.isStringLiteral(node) ? node.text : undefined
}

function validateDatabaseConfig(path: string) {
  const source = readFileSync(path, 'utf8')
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const syntax = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ESNext },
    reportDiagnostics: true,
  })
  const exports = file.statements.filter(ts.isExportAssignment)
  const variableStatements = file.statements.filter(ts.isVariableStatement)
  if (
    syntax.diagnostics?.some((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error) ||
    exports.length !== 1 ||
    variableStatements.length !== 1 ||
    file.statements.some(
      (statement) =>
        !ts.isImportDeclaration(statement) &&
        !ts.isExportAssignment(statement) &&
        !ts.isVariableStatement(statement)
    )
  ) {
    throw new Error('generated database config contains unsupported executable structure')
  }
  const imports = file.statements.filter(ts.isImportDeclaration)
  const validImports =
    imports.length === 2 &&
    imports.every((entry) => {
      const clause = entry.importClause
      if (
        !ts.isStringLiteral(entry.moduleSpecifier) ||
        !clause ||
        clause.isTypeOnly ||
        entry.attributes
      )
        return false
      if (entry.moduleSpecifier.text === '@adonisjs/core/services/app')
        return clause.name?.text === 'app' && !clause.namedBindings
      const bindings = clause.namedBindings
      return (
        entry.moduleSpecifier.text === '@adonisjs/lucid' &&
        !clause.name &&
        bindings &&
        ts.isNamedImports(bindings) &&
        bindings.elements.length === 1 &&
        bindings.elements[0].name.text === 'defineConfig' &&
        !bindings.elements[0].propertyName &&
        !bindings.elements[0].isTypeOnly
      )
    }) &&
    new Set(imports.map((entry) => (entry.moduleSpecifier as ts.StringLiteral).text)).size === 2
  if (!validImports)
    throw new Error('generated database config imports unsupported runtime modules')
  const [declaration] = variableStatements[0].declarationList.declarations
  const exportedName = exports[0].expression
  if (
    variableStatements[0].declarationList.declarations.length !== 1 ||
    (variableStatements[0].declarationList.flags & ts.NodeFlags.Const) === 0 ||
    exports[0].isExportEquals ||
    !ts.isIdentifier(declaration.name) ||
    !ts.isIdentifier(exportedName) ||
    declaration.name.text !== 'dbConfig' ||
    exportedName.text !== 'dbConfig' ||
    !declaration.initializer
  ) {
    throw new Error('generated database config must export its single dbConfig declaration')
  }
  const assignment = declaration.initializer
  if (
    !ts.isCallExpression(assignment) ||
    !ts.isIdentifier(assignment.expression) ||
    assignment.expression.text !== 'defineConfig' ||
    assignment.arguments.length !== 1 ||
    assignment.typeArguments?.length
  )
    throw new Error('generated database config must directly export defineConfig')
  const [argument] = assignment.arguments
  if (!argument || !ts.isObjectLiteralExpression(argument))
    throw new Error('generated database config must use a literal config object')
  const configProperties = properties(argument)
  if ([...configProperties.keys()].some((name) => !['connection', 'connections'].includes(name)))
    throw new Error('generated database config contains unsupported selection properties')
  const selectedConnection = stringValue(configProperties.get('connection'))
  const connections = configProperties.get('connections')
  if (!connections || !ts.isObjectLiteralExpression(connections))
    throw new Error('generated database connections must be a literal object')
  const connectionProperties = properties(connections)
  if ([...connectionProperties.keys()].some((name) => name !== 'sqlite'))
    throw new Error('generated database config contains unsupported database connections')
  const sqlite = connectionProperties.get('sqlite')
  if (!sqlite || !ts.isObjectLiteralExpression(sqlite))
    throw new Error('generated SQLite connection must be a literal object')
  const sqliteProperties = properties(sqlite)
  if (
    [...sqliteProperties.keys()].some(
      (name) =>
        !['client', 'connection', 'useNullAsDefault', 'migrations', 'schemaGeneration'].includes(
          name
        )
    )
  )
    throw new Error('generated SQLite connection contains unsupported selection properties')
  const client = stringValue(sqliteProperties.get('client'))
  const connection = sqliteProperties.get('connection')
  if (!connection || !ts.isObjectLiteralExpression(connection))
    throw new Error('generated SQLite file settings must be a literal object')
  const fileProperties = properties(connection)
  if ([...fileProperties.keys()].some((name) => name !== 'filename'))
    throw new Error('generated SQLite file settings contain unsupported properties')
  const filename = fileProperties.get('filename')
  const validFilename =
    filename &&
    ts.isCallExpression(filename) &&
    ts.isPropertyAccessExpression(filename.expression) &&
    ts.isIdentifier(filename.expression.expression) &&
    filename.expression.expression.text === 'app' &&
    filename.expression.name.text === 'tmpPath' &&
    filename.arguments.length === 1 &&
    stringValue(filename.arguments[0]) === 'db.sqlite3'

  if (selectedConnection !== 'sqlite' || client !== 'better-sqlite3' || !validFilename)
    throw new Error(
      "generated database config must select better-sqlite3 at app.tmpPath('db.sqlite3')"
    )
}

function validateStarterMetadata(root: string) {
  const packagePath = join(root, 'package.json')
  const acePath = join(root, 'ace.js')
  const configDir = join(root, 'config')
  const databaseConfigPath = join(configDir, 'database.ts')
  assertRegularFile(packagePath, 'generated package metadata')
  assertRegularFile(acePath, 'generated Ace entrypoint')
  assertDirectory(configDir, 'generated config directory')
  assertRegularFile(databaseConfigPath, 'generated database config')

  const packageText = readFileSync(packagePath, 'utf8')
  let metadata: {
    name?: unknown
    dependencies?: Record<string, unknown>
    devDependencies?: Record<string, unknown>
  }
  try {
    metadata = JSON.parse(packageText) as typeof metadata
  } catch (error) {
    throw new Error('generated package metadata is invalid JSON', { cause: error })
  }
  if (typeof metadata.name !== 'string' || !metadata.name)
    throw new Error('generated package metadata has no app name')
  const dependencies = { ...metadata.dependencies, ...metadata.devDependencies }
  if (
    !dependencies['@adonisjs/core'] ||
    !dependencies['@adonisjs/lucid'] ||
    !dependencies['better-sqlite3']
  )
    throw new Error('generated app metadata does not describe the supported Adonis SQLite starter')

  validateDatabaseConfig(databaseConfigPath)
}

function validateInheritedEnvironment(env: NodeJS.ProcessEnv, databasePath: string) {
  if (env.NODE_OPTIONS) throw new Error('refusing inherited NODE_OPTIONS for demo commands')
  for (const [name, value] of Object.entries(env)) {
    if (!value || !/^(?:DB_|DATABASE_)/i.test(name)) continue
    if (name === 'DB_CONNECTION' && value === 'sqlite') continue
    if (name === 'DB_DATABASE' && resolve(value) === databasePath) continue
    throw new Error(`refusing inherited database override ${name}`)
  }
}

export function writeDemoIdentity(appDir: string, role: DemoRole) {
  const root = realpathSync(appDir)
  assertDirectory(root, 'generated app root')
  const markerPath = join(root, markerName)
  try {
    const markerStat = lstatSync(markerPath)
    if (!markerStat.isFile() || markerStat.isSymbolicLink())
      throw new Error(`demo identity marker must be a regular file: ${markerPath}`)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  validateStarterMetadata(root)
  const starter = attestStarter(readStarter(root))
  const identity: DemoIdentity = { version: 1, role, root, starter }
  writeFileSync(markerPath, `${JSON.stringify(identity, null, 2)}\n`, {
    mode: 0o644,
    flag: 'wx',
  })
}

export function validateDemoIdentity(
  appDir: string,
  role: DemoRole,
  inheritedEnv: NodeJS.ProcessEnv = process.env,
  restoringSetup = false
): ValidatedDemo {
  let root: string
  try {
    root = realpathSync(appDir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      throw new Error(`demo app root does not exist: ${appDir}`, { cause: error })
    throw error
  }
  assertDirectory(root, 'demo app root')
  const markerPath = join(root, markerName)
  assertRegularFile(markerPath, 'demo identity marker')

  const markerText = readFileSync(markerPath, 'utf8')
  let identity: DemoIdentity
  try {
    identity = JSON.parse(markerText) as DemoIdentity
  } catch (error) {
    throw new Error('demo identity marker is invalid JSON', { cause: error })
  }
  if (!identity || typeof identity !== 'object')
    throw new Error('demo identity marker must be a JSON object')
  if (identity.version !== 1) throw new Error('unsupported demo identity marker version')
  if (identity.role !== role) throw new Error(`demo identity role must be ${role}`)
  if (identity.root !== root)
    throw new Error('demo identity root does not match the canonical app root')
  if (role === 'setup-recording')
    assertDirectory(join(root, '.git'), 'setup demo starter repository')

  if (!restoringSetup) {
    verifySnapshot(readStarter(root), identity.starter)
    validateStarterMetadata(root)
  } else if (role !== 'setup-recording') throw new Error('only setup recordings restore a starter')
  const databasePath = sqlitePath(root)
  validateInheritedEnvironment(inheritedEnv, databasePath)
  const childEnv = { ...inheritedEnv }
  for (const name of Object.keys(childEnv)) {
    if (/^(?:DB_|DATABASE_|GIT_)/i.test(name)) delete childEnv[name]
  }
  delete childEnv.NODE_OPTIONS
  delete childEnv.NODE_PATH
  childEnv.DB_CONNECTION = 'sqlite'
  childEnv.DB_DATABASE = databasePath
  return { root, databasePath, childEnv }
}
