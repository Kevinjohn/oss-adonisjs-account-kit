import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from '@japa/runner'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))

/** Tracked root and docs/ Markdown files, without the changelog. */
function trackedDocuments(): string[] {
  // Only tracked documents: ignored local notes (for example PLAN*.md) are not published.
  const listed = spawnSync('git', ['ls-files', '-z', '--', ':(glob)*.md', ':(glob)docs/*.md'], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
  if (listed.status !== 0) throw new Error(listed.stderr)
  // The changelog records renamed files, so its old paths are history, not citations.
  return listed.stdout.split('\0').filter((name) => name !== '' && name !== 'CHANGELOG.md')
}

test('every spec file cited by the documentation exists', async ({ assert }) => {
  const documents = trackedDocuments()
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

test('every test title quoted after a spec citation is in that spec', async ({ assert }) => {
  const misplaced: string[] = []
  let checked = 0
  for (const document of trackedDocuments()) {
    const text = await readFile(join(repoRoot, document), 'utf8')
    // `path` — `title`, `title`, and `title`   or   `path`: “title”; “title”
    const citations = text.matchAll(
      /`((?:examples\/[\w-]+\/)?tests\/[\w/.-]+\.spec\.ts)`(?: — ((?:`[^`]+`(?:, and |, | and )?)+)|: ((?:“[^”]+”(?:; )?)+))/g
    )
    for (const [, path, backticked, curly] of citations) {
      if (!existsSync(join(repoRoot, path))) continue
      const source = await readFile(join(repoRoot, path), 'utf8')
      const titles = [
        ...(backticked ?? '').matchAll(/`([^`]+)`/g),
        ...(curly ?? '').matchAll(/“([^”]+)”/g),
      ]
      for (const [, title] of titles) {
        checked++
        if (!source.includes(title)) misplaced.push(`${document}: ${path}: ${title}`)
      }
    }
  }
  assert.isAbove(checked, 0)
  assert.deepEqual(misplaced, [])
})
