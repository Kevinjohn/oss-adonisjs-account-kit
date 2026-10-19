import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join, posix } from 'node:path'
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

/** GitHub's heading anchors: lowercase, punctuation dropped, spaces as hyphens. */
async function headingAnchors(document: string): Promise<Set<string>> {
  const source = await readFile(join(repoRoot, document), 'utf8')
  const headings = source.replace(/```[\s\S]*?```/g, '').matchAll(/^#{1,6} (.+)$/gm)
  return new Set(
    [...headings].map(([, heading]) =>
      heading
        .toLowerCase()
        .replace(/[^\p{L}\p{N} _-]/gu, '')
        .replace(/ /g, '-')
    )
  )
}

test('every anchor in a relative Markdown link names a heading', async ({ assert }) => {
  const broken: string[] = []
  let checked = 0
  for (const document of trackedDocuments()) {
    const source = await readFile(join(repoRoot, document), 'utf8')
    const text = source.replace(/```[\s\S]*?```/g, '')
    for (const [, target] of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      if (/^[a-z][a-z\d+.-]*:/i.test(target) || !target.includes('#')) continue
      const [path, anchor] = target.split('#')
      const linked = path ? posix.join(posix.dirname(document), path) : document
      if (!linked.endsWith('.md') || !existsSync(join(repoRoot, linked))) continue
      checked++
      const anchors = await headingAnchors(linked)
      if (!anchors.has(decodeURIComponent(anchor))) broken.push(`${document}: ${target}`)
    }
  }
  assert.isAbove(checked, 0)
  assert.deepEqual(broken, [])
})

/** Paths in the npm tarball; Markdown there is read without the rest of the repository. */
function packedFiles(): Set<string> {
  const packed = spawnSync('pnpm', ['pack', '--dry-run', '--json'], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
  if (packed.status !== 0) throw new Error(packed.stderr)
  return new Set(JSON.parse(packed.stdout).files.map((file: { path: string }) => file.path))
}

test('relative links in packed Markdown stay inside the package', async ({ assert }) => {
  const files = packedFiles()
  const broken: string[] = []
  // npm rewrites the README's relative links to the repository, so only other files count.
  for (const document of [...files].filter((f) => f.endsWith('.md') && f !== 'README.md')) {
    const source = await readFile(join(repoRoot, document), 'utf8')
    // Docs images are left out of the package; npm readers do not render them.
    const text = source.replace(/```[\s\S]*?```/g, '').replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    for (const [, target] of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      if (/^(?:[a-z][a-z\d+.-]*:|#)/i.test(target)) continue
      const path = posix.normalize(posix.join(posix.dirname(document), target.split('#')[0]))
      if (!files.has(path) && ![...files].some((file) => file.startsWith(`${path}/`)))
        broken.push(`${document}: ${target}`)
    }
  }
  assert.deepEqual(broken, [])
})
