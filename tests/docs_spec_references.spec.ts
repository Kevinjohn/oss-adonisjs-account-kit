import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from '@japa/runner'

test('every spec file cited by the documentation exists', async ({ assert }) => {
  const repoRoot = fileURLToPath(new URL('..', import.meta.url))
  // Only tracked documents: ignored local notes (for example PLAN*.md) are not published.
  const listed = spawnSync('git', ['ls-files', '-z', '--', ':(glob)*.md', ':(glob)docs/*.md'], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
  assert.equal(listed.status, 0, listed.stderr)
  // The changelog records renamed files, so its old paths are history, not citations.
  const documents = listed.stdout
    .split('\0')
    .filter((name) => name !== '' && name !== 'CHANGELOG.md')
  assert.include(documents, 'docs/release-assessment.md')
  const missing: string[] = []
  for (const document of documents) {
    const text = await readFile(join(repoRoot, document), 'utf8')
    // Permalinks pinned to a commit (`/blob/<sha>/tests/...`) stay valid after a file moves.
    const citations = text.matchAll(
      /(?<!\/blob\/[0-9a-f]+\/)\b(?:examples\/[\w-]+\/)?tests\/[\w/.-]+\.spec\.ts\b/g
    )
    for (const [path] of citations) {
      const citation = `${document}: ${path}`
      if (!existsSync(join(repoRoot, path))) missing.push(citation)
    }
  }
  assert.deepEqual(missing, [])
})
