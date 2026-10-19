import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from '@japa/runner'

test('packs public documentation and examples without private planning documents', async ({
  assert,
}) => {
  const root = await mkdtemp(join(tmpdir(), 'account-kit-packaging-'))
  try {
    const repoRoot = fileURLToPath(new URL('..', import.meta.url))
    const manifest = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8'))
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({
        name: 'account-kit-packaging-fixture',
        version: '0.0.0',
        files: manifest.files,
      })
    )
    await writeFile(join(root, '.gitignore'), await readFile(join(repoRoot, '.gitignore')))
    const publicFiles = [
      'build/index.js',
      'docs/usage.md',
      'examples/api/README.md',
      'README-AGENTS.md',
      'CHANGELOG.md',
    ]
    const privateFiles = [
      'PLAN-private.md',
      'docs/PRD-private.md',
      'docs/reviews/private-review.md',
      'docs/reviews/nested/private-notes.md',
      'docs/maintainers/release-assessment.md',
      'docs/.vitepress/dist/index.html',
      'docs/api/index.md',
    ]
    for (const file of [...publicFiles, ...privateFiles]) {
      await mkdir(dirname(join(root, file)), { recursive: true })
      await writeFile(join(root, file), 'fixture content\n')
    }
    const packed = spawnSync('pnpm', ['pack', '--dry-run', '--json'], {
      cwd: root,
      encoding: 'utf8',
    })
    assert.equal(packed.status, 0, packed.stderr)
    const files = JSON.parse(packed.stdout).files.map((file: { path: string }) => file.path)
    for (const file of publicFiles) assert.include(files, file)
    for (const file of privateFiles) assert.notInclude(files, file)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
