import ts from 'typescript'
import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from '@japa/runner'

const root = fileURLToPath(new URL('..', import.meta.url))
/** Core source: every package directory except the admission module itself. */
const coreDirectories = ['src', 'providers', 'commands', 'http', 'services']
/** Admission entry points may name the optional module. */
const allowed = new Set([
  'commands/admission_install.ts',
  'providers/account_admission_provider.ts',
])
function importsAdmission(source: string): boolean {
  const runtime = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ESNext,
      verbatimModuleSyntax: true,
      removeComments: true,
    },
  }).outputText
  return /(?:from\s+|import\s*\(\s*)['"][^'"]*\badmission(?:\/[^'"]*)?['"]/.test(runtime)
}

async function sources(directory: string): Promise<string[]> {
  const entries = await readdir(join(root, directory), { withFileTypes: true, recursive: true })
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => relative(root, join(entry.parentPath, entry.name)))
}

test('core never imports the admission module', async ({ assert }) => {
  const files = ['index.ts', 'configure.ts']
  for (const directory of coreDirectories) files.push(...(await sources(directory)))
  const core = files.filter(
    (file) =>
      !file.startsWith('src/admission/') &&
      !file.startsWith('commands/admission/') &&
      !allowed.has(file)
  )
  assert.isAbove(core.length, 50)
  const offenders: string[] = []
  for (const file of core)
    if (importsAdmission(await readFile(join(root, file), 'utf8'))) offenders.push(file)
  assert.deepEqual(offenders, [])
})

test('the boundary check notices an admission import', ({ assert }) => {
  assert.isTrue(importsAdmission(`import { x } from './admission/service.js'`))
  assert.isTrue(importsAdmission(`await import('@kevinjohn/adonisjs-account-kit/admission')`))
  assert.isFalse(importsAdmission(`import { x } from './registration.js'`))
  assert.isFalse(importsAdmission(`import type { AdmissionConfig } from './admission/types.ts'`))
  assert.isFalse(importsAdmission(`export type * from './admission/types.ts'`))
  assert.isTrue(importsAdmission(`export { AccountAdmission } from './admission/main.ts'`))
})
