import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join, posix } from 'node:path'
import { test } from '@japa/runner'
import { repoRoot, trackedMarkdown } from './helpers/tracked_markdown.js'

/** Tracked Markdown outside dependencies; ignored local notes are not published. */
function trackedDocuments(): string[] {
  // The changelog records renamed files, so its old paths are history, not links.
  return trackedMarkdown(['**/*.md']).filter((name) => name !== 'CHANGELOG.md')
}

function trackedPaths(): Set<string> {
  const result = spawnSync('git', ['ls-files', '-z'], { cwd: repoRoot, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr)
  return new Set(
    result.stdout
      .split('\0')
      .filter(Boolean)
      .map((path) => posix.normalize(path))
  )
}

test('every relative Markdown link points at a tracked path', async ({ assert }) => {
  const broken: string[] = []
  const tracked = trackedPaths()
  const trackedDirectories = new Set<string>(['.'])
  for (const path of tracked) {
    let directory = posix.dirname(path)
    while (directory !== '.') {
      trackedDirectories.add(directory)
      directory = posix.dirname(directory)
    }
  }
  let checked = 0
  for (const document of trackedDocuments()) {
    const source = await readFile(join(repoRoot, document), 'utf8')
    const text = source.replace(/```[\s\S]*?```/g, '')
    for (const [, target] of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      if (/^(?:[a-z][a-z\d+.-]*:|#)/i.test(target)) continue
      const path = decodeURIComponent(target.split('#')[0])
      checked++
      const linked = posix.normalize(posix.join(posix.dirname(document), path))
      const directory = linked.replace(/\/+$/, '') || '.'
      const isTracked = tracked.has(linked) || trackedDirectories.has(directory)
      if (!isTracked) broken.push(`${document}: ${target}`)
    }
  }
  assert.isAbove(checked, 0)
  assert.deepEqual(broken, [])
})

// The VitePress site publishes these sources at another URL and does not rewrite relative links
// to them, so a link to the source path is a 404 on the site.
test('no docs link targets a page the site publishes at another URL', async ({ assert }) => {
  const config = await readFile(join(repoRoot, 'docs/.vitepress/config.mts'), 'utf8')
  const rewritten = new Set(
    [...config.match(/rewrites: \{([^}]*)\}/)![1].matchAll(/'([^']+)':/g)].map(
      ([, source]) => `docs/${source}`
    )
  )
  assert.isAbove(rewritten.size, 0)
  const broken: string[] = []
  for (const document of trackedMarkdown(['docs/**/*.md'])) {
    const source = await readFile(join(repoRoot, document), 'utf8')
    for (const [, target] of source.replace(/```[\s\S]*?```/g, '').matchAll(/\]\(([^)\s]+)\)/g)) {
      if (/^(?:[a-z][a-z\d+.-]*:|#)/i.test(target)) continue
      const linked = posix.normalize(posix.join(posix.dirname(document), target.split('#')[0]))
      if (rewritten.has(linked)) broken.push(`${document}: ${target}`)
    }
  }
  assert.deepEqual(broken, [])
})

// Packed Markdown and GitHub readers follow absolute links to this repository's main branch.
test('absolute links to the main branch point at tracked paths', async ({ assert }) => {
  const listed = spawnSync('git', ['ls-files', '-z'], { cwd: repoRoot, encoding: 'utf8' })
  if (listed.status !== 0) throw new Error(listed.stderr)
  const tracked = new Set(listed.stdout.split('\0').filter(Boolean))
  const broken: string[] = []
  let checked = 0
  const prefix =
    /https:\/\/github\.com\/Kevinjohn\/oss-adonisjs-account-kit\/(?:blob|tree)\/main\/([^)\s#>"]+)/g
  for (const document of trackedMarkdown(['**/*.md'])) {
    const source = await readFile(join(repoRoot, document), 'utf8')
    for (const [, target] of source.matchAll(prefix)) {
      checked++
      const path = decodeURIComponent(target).replace(/\/+$/, '')
      if (!tracked.has(path) && ![...tracked].some((file) => file.startsWith(`${path}/`)))
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
