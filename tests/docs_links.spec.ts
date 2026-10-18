import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from '@japa/runner'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))

/** Tracked Markdown outside dependencies; ignored local notes are not published. */
function trackedDocuments(): string[] {
  const listed = spawnSync('git', ['ls-files', '-z', '--', ':(glob)**/*.md'], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
  if (listed.status !== 0) throw new Error(listed.stderr)
  // The changelog records renamed files, so its old paths are history, not links.
  return listed.stdout.split('\0').filter((name) => name !== '' && name !== 'CHANGELOG.md')
}

test('every relative Markdown link points at a tracked path', async ({ assert }) => {
  const broken: string[] = []
  let checked = 0
  for (const document of trackedDocuments()) {
    const source = await readFile(join(repoRoot, document), 'utf8')
    const text = source.replace(/```[\s\S]*?```/g, '')
    for (const [, target] of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      if (/^(?:[a-z][a-z\d+.-]*:|#)/i.test(target)) continue
      const path = decodeURIComponent(target.split('#')[0])
      checked++
      if (!existsSync(join(repoRoot, dirname(document), path)))
        broken.push(`${document}: ${target}`)
    }
  }
  assert.isAbove(checked, 0)
  assert.deepEqual(broken, [])
})
