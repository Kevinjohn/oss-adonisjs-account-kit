import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from '@japa/runner'

/** Stale citations tracked by https://github.com/Kevinjohn/oss-adonisjs-account-kit/issues/105. */
const knownStale = new Set(['docs/release-assessment.md: tests/setup.spec.ts'])

test('every spec file cited by the documentation exists', async ({ assert }) => {
  const repoRoot = fileURLToPath(new URL('..', import.meta.url))
  const rootFiles = await readdir(repoRoot)
  const docsFiles = await readdir(join(repoRoot, 'docs'))
  // The changelog records renamed files, so its old paths are history, not citations.
  const documents = [
    ...rootFiles.filter((name) => name.endsWith('.md') && name !== 'CHANGELOG.md'),
    ...docsFiles.filter((name) => name.endsWith('.md')).map((name) => join('docs', name)),
  ]
  const missing: string[] = []
  for (const document of documents) {
    const text = await readFile(join(repoRoot, document), 'utf8')
    // Permalinks pinned to a commit (`/blob/<sha>/tests/...`) stay valid after a file moves.
    const citations = text.matchAll(
      /(?<!\/blob\/[0-9a-f]+\/)\b(?:examples\/[\w-]+\/)?tests\/[\w/.-]+\.spec\.ts\b/g
    )
    for (const [path] of citations) {
      const citation = `${document}: ${path}`
      if (!existsSync(join(repoRoot, path)) && !knownStale.has(citation)) missing.push(citation)
    }
  }
  assert.deepEqual(missing, [])
})
