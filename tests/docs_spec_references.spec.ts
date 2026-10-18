import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from '@japa/runner'

test('every spec file cited by the documentation exists', async ({ assert }) => {
  const repoRoot = fileURLToPath(new URL('..', import.meta.url))
  const documents = [
    ...(await readdir(repoRoot)).filter((name) => name.endsWith('.md')),
    ...(await readdir(join(repoRoot, 'docs')))
      .filter((name) => name.endsWith('.md'))
      .map((name) => join('docs', name)),
  ]
  const missing: string[] = []
  for (const document of documents) {
    const text = await readFile(join(repoRoot, document), 'utf8')
    for (const [path] of text.matchAll(/\b(?:examples\/[\w-]+\/)?tests\/[\w/.-]+\.spec\.ts\b/g)) {
      if (!existsSync(join(repoRoot, path))) missing.push(`${document}: ${path}`)
    }
  }
  assert.deepEqual(missing, [])
})
