import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from '@japa/runner'

test('packs the build and top-level documents, not docs, examples or planning documents', async ({
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
      'build/shared_chunk.js',
      'build/src/auth/main.js',
      'build/src/auth/main.d.ts',
      'build/src/http/main.js',
      'build/src/http/main.d.ts',
      'build/src/transaction/main.js',
      'build/src/transaction/main.d.ts',
      'build/stubs/main.js',
      'build/config/account_kit.stub',
      'build/make/migration/create_account_admissions.stub',
      'build/make/migration/create_account_sessions.stub',
      'README-AGENTS.md',
      'CHANGELOG.md',
    ]
    const privateFiles = [
      'build/bin/check_changed.js',
      'build/examples/hypermedia/app/validators/old_input.d.ts',
      'build/.prepare-complete',
      'build/tests/package_exports.spec.js',
      'docs/guide/usage.md',
      'examples/api/README.md',
      'PLAN-private.md',
      'docs/maintainers/design/prd-private.md',
      'docs/maintainers/reviews/private-review.md',
      'docs/maintainers/reviews/nested/private-notes.md',
      'docs/maintainers/release-assessment.md',
      'docs/.vitepress/dist/index.html',
      'docs/reference/api/index.md',
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
