import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test } from '@japa/runner'
import { repoRoot, trackedMarkdown } from './helpers/tracked_markdown.js'

// Paths that climb out of bin/ name repository files. A script that resolves a moved file fails
// only when someone runs it, often after a long setup.
test('every repository path a bin script resolves from its own location exists', async ({
  assert,
}) => {
  const missing: string[] = []
  let checked = 0
  for (const script of trackedMarkdown(['bin/**/*.ts'])) {
    const source = await readFile(join(repoRoot, script), 'utf8')
    const base = pathToFileURL(join(repoRoot, script))
    for (const [, target] of source.matchAll(/new URL\('(\.\.\/[^']*)', import\.meta\.url\)/g)) {
      checked++
      if (!existsSync(fileURLToPath(new URL(target, base)))) missing.push(`${script}: ${target}`)
    }
  }
  assert.isAbove(checked, 0)
  assert.deepEqual(missing, [])
})
