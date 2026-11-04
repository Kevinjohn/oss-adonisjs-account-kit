// The generated starter bootstrap is a deliberately narrow recording contract.
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import * as ts from 'typescript'

export const starterPaths = [
  'ace.js',
  'bin/console.ts',
  'adonisrc.ts',
  'config/database.ts',
] as const
export type StarterSnapshot = Record<string, string>
// Executable statements of the supported generated starter; comments/format are ignored.
export const starterAce = `import '@poppinss/ts-exec'


await import('./bin/console.js')`
export const starterConsole = `await import('reflect-metadata')
const { Ignitor, prettyPrintError } = await import('@adonisjs/core/ignitor')


const APP_ROOT = new URL('../', import.meta.url)


const IMPORTER = (filePath: string) => {
  if (filePath.startsWith('./') || filePath.startsWith('../')) {
    return import(new URL(filePath, APP_ROOT).href)
  }
  return import(filePath)
}

new Ignitor(APP_ROOT, { importer: IMPORTER })
  .tap((app) => {
    app.booting(async () => {
      await import('#start/env')
    })
    app.listen('SIGTERM', () => app.terminate())
    app.listenIf(app.managedByPm2, 'SIGINT', () => app.terminate())
  })
  .ace()
  .handle(process.argv.splice(2))
  .catch((error) => {
    process.exitCode = 1
    prettyPrintError(error)
  })`

function canonical(source: string) {
  const file = ts.createSourceFile('starter.ts', source, ts.ScriptTarget.Latest, true)
  return ts.createPrinter({ removeComments: true }).printFile(file)
}

export function digest(source: string) {
  return createHash('sha256').update(source).digest('hex')
}

export const shadowPaths = ['ace', 'bin/console.js', 'adonisrc.js', 'config/database.js']

// ConfigLoader strips these extensions and uses path segments as namespace keys.
// A nested database tree also contributes to that same namespace.
export function assertDatabaseInventory(paths: string[]) {
  for (const path of paths) {
    if (
      path === 'database' ||
      path.startsWith('database/') ||
      /^database\.(?:ts|js|mjs|cjs|json)$/.test(path)
    ) {
      if (path !== 'database.ts') throw new Error(`ambiguous generated database namespace: ${path}`)
    }
  }
}

export function readStarter(root: string) {
  assertDatabaseInventory(readdirSync(join(root, 'config')))
  for (const path of shadowPaths) {
    try {
      lstatSync(join(root, path))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    throw new Error(`generated starter has an overriding entrypoint: ${path}`)
  }
  for (const directory of ['bin', 'config']) {
    if (
      !lstatSync(join(root, directory)).isDirectory() ||
      lstatSync(join(root, directory)).isSymbolicLink()
    )
      throw new Error(`generated ${directory} must be a real directory`)
  }
  return Object.fromEntries(
    starterPaths.map((path) => {
      const stat = lstatSync(join(root, path))
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
        throw new Error(`generated bootstrap/config must be a regular unlinked file: ${path}`)
      return [path, readFileSync(join(root, path), 'utf8')]
    })
  )
}

export function attestStarter(files: Record<string, string>): StarterSnapshot {
  if (
    canonical(files['ace.js']) !== canonical(starterAce) ||
    canonical(files['bin/console.ts']) !== canonical(starterConsole)
  )
    throw new Error('unsupported generated Ace bootstrap/root')
  const rc = ts.createSourceFile('adonisrc.ts', files['adonisrc.ts'], ts.ScriptTarget.Latest, true)
  const exports = rc.statements.filter(ts.isExportAssignment)
  const configuration = exports[0]?.expression
  const definition = rc.statements
    .filter(ts.isImportDeclaration)
    .find(
      (entry) =>
        ts.isStringLiteral(entry.moduleSpecifier) &&
        entry.moduleSpecifier.text === '@adonisjs/core/app'
    )
  const bindings = definition?.importClause?.namedBindings
  if (
    rc.statements.some(
      (statement) => !ts.isImportDeclaration(statement) && !ts.isExportAssignment(statement)
    ) ||
    exports.length !== 1 ||
    exports[0].isExportEquals ||
    !configuration ||
    !ts.isCallExpression(configuration) ||
    !ts.isIdentifier(configuration.expression) ||
    configuration.expression.text !== 'defineConfig' ||
    configuration.arguments.length !== 1 ||
    configuration.typeArguments?.length ||
    !definition ||
    definition.importClause?.name ||
    definition.importClause?.isTypeOnly ||
    definition.attributes ||
    !bindings ||
    !ts.isNamedImports(bindings) ||
    bindings.elements.length !== 1 ||
    bindings.elements[0].name.text !== 'defineConfig' ||
    bindings.elements[0].propertyName ||
    bindings.elements[0].isTypeOnly ||
    !ts.isObjectLiteralExpression(configuration.arguments[0])
  )
    throw new Error('generated rc must directly export defineConfig with its literal configuration')
  const names = new Set<string>()
  const allowed = new Set([
    'experimental',
    'commands',
    'providers',
    'preloads',
    'tests',
    'metaFiles',
    'hooks',
  ])
  for (const member of configuration.arguments[0].properties) {
    if (
      !ts.isPropertyAssignment(member) ||
      (!ts.isIdentifier(member.name) && !ts.isStringLiteral(member.name)) ||
      !allowed.has(member.name.text) ||
      names.has(member.name.text)
    )
      throw new Error(
        'generated rc must use supported literal properties without directory overrides or presets'
      )
    names.add(member.name.text)
    const objectValue = ['experimental', 'tests', 'hooks'].includes(member.name.text)
    if (
      objectValue
        ? !ts.isObjectLiteralExpression(member.initializer)
        : !ts.isArrayLiteralExpression(member.initializer)
    )
      throw new Error('generated rc properties must use the generated object/array form')
  }
  return Object.fromEntries(starterPaths.map((path) => [path, digest(files[path])]))
}

export function verifySnapshot(files: Record<string, string>, snapshot: StarterSnapshot) {
  if (
    !snapshot ||
    starterPaths.some(
      (path) => typeof snapshot[path] !== 'string' || digest(files[path]) !== snapshot[path]
    )
  )
    throw new Error('generated bootstrap/config differs from its producer snapshot')
}
