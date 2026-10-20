import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from '@japa/runner'

const root = fileURLToPath(new URL('..', import.meta.url))
/** Core source: every package directory except the admission module itself. */
const coreDirectories = ['src', 'providers', 'commands', 'http', 'services', 'adapters', 'testing']
/** The install command must write the admission files, so it alone may name the module. */
const allowed = new Set(['commands/admission_install.ts'])
const importsAdmission = /(?:from\s+|import\s*\(\s*)['"][^'"]*\badmission(?:\/[^'"]*)?['"]/

async function sources(directory: string): Promise<string[]> {
  const entries = await readdir(join(root, directory), { withFileTypes: true, recursive: true })
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => relative(root, join(entry.parentPath, entry.name)))
}

test('core never imports the admission module', async ({ assert }) => {
  const files = ['index.ts', 'configure.ts']
  for (const directory of coreDirectories) files.push(...(await sources(directory)))
  const core = files.filter((file) => !file.startsWith('src/admission/') && !allowed.has(file))
  assert.isAbove(core.length, 50)
  const offenders: string[] = []
  for (const file of core)
    if (importsAdmission.test(await readFile(join(root, file), 'utf8'))) offenders.push(file)
  assert.deepEqual(offenders, [])
})

test('the boundary check notices an admission import', ({ assert }) => {
  assert.isTrue(importsAdmission.test(`import { x } from './admission/service.js'`))
  assert.isTrue(importsAdmission.test(`await import('adonisjs-account-kit/admission')`))
  assert.isFalse(importsAdmission.test(`import { x } from './registration.js'`))
})
