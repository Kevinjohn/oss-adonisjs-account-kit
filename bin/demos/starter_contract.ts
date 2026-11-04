// The generated starter bootstrap is a deliberately narrow recording contract.
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
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

export function readStarter(root: string) {
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
  // Generated starters use the Application defaults. No directory override is supported.
  function inspect(node: ts.Node) {
    if ((ts.isIdentifier(node) || ts.isStringLiteral(node)) && node.text === 'directories')
      throw new Error('generated rc directory overrides are unsupported')
    ts.forEachChild(node, inspect)
  }
  inspect(rc)
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
