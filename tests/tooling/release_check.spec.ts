import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from '@japa/runner'

const root = join(import.meta.dirname, '../..')

/** Run the release gate in a throwaway package with the given changelog. */
async function releaseCheck(changelog: string) {
  const directory = await mkdtemp(join(tmpdir(), 'account_kit_release_check_'))
  try {
    await writeFile(
      join(directory, 'package.json'),
      JSON.stringify({ name: 'release-fixture', version: '9.9.9', scripts: { build: 'true' } })
    )
    await writeFile(join(directory, 'CHANGELOG.md'), changelog)
    const environment: NodeJS.ProcessEnv = { ...process.env, GITHUB_REPOSITORY: 'owner/repo' }
    delete environment.GITHUB_ENV
    const result = spawnSync('bash', [join(root, 'bin/release_check.sh')], {
      cwd: directory,
      encoding: 'utf8',
      env: environment,
    })
    const notes = await readFile(join(directory, 'tmp/release/notes.md'), 'utf8').catch((error) => {
      if (error.code !== 'ENOENT') throw error
      return ''
    })
    let archiveSha256: string | undefined
    if (result.status === 0) {
      const files = await readdir(join(directory, 'tmp/release'))
      const archives = files.filter((name) => name.endsWith('.tgz'))
      if (archives.length !== 1) throw new Error('Release fixture did not produce one archive')
      archiveSha256 = createHash('sha256')
        .update(await readFile(join(directory, 'tmp/release', archives[0])))
        .digest('hex')
    }
    return { ...result, notes, archiveSha256 }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

test('release gate accepts an empty Unreleased section above the released version', async ({
  assert,
}) => {
  const result = await releaseCheck(
    '# Changelog\n\n## Unreleased\n\n## 9.9.9 - 2026-01-01\n\n- A\n'
  )
  assert.equal(result.status, 0, result.stderr)
  assert.include(result.stdout, 'ready: v9.9.9')
  assert.match(result.archiveSha256 ?? '', /^[a-f0-9]{64}$/)
  assert.include(result.notes, `SHA-256: \`${result.archiveSha256}\``)
})

test('release gate refuses entries under Unreleased, which the tarball would ship', async ({
  assert,
}) => {
  const result = await releaseCheck(
    '# Changelog\n\n## Unreleased\n\n- Later change\n\n## 9.9.9 - 2026-01-01\n\n- A\n'
  )
  assert.notEqual(result.status, 0)
  assert.include(result.stderr, "entries under '## Unreleased'")
})

test('release gate matches the version heading literally', async ({ assert }) => {
  const result = await releaseCheck(
    '# Changelog\n\n## Unreleased\n\n## 9x9x9 - 2026-01-01\n\n- A\n'
  )
  assert.notEqual(result.status, 0)
  assert.include(result.stderr, "no '## 9.9.9 - YYYY-MM-DD' heading")
})

test('release notes take only the exact version section', async ({ assert }) => {
  const result = await releaseCheck(
    '# Changelog\n\n## Unreleased\n\n## 9.9.9 - 2026-01-01\n\n- Current\n\n## 9a9a9 - 2025-01-01\n\n- Other\n'
  )
  assert.equal(result.status, 0, result.stderr)
  assert.include(result.notes, '- Current')
  assert.notInclude(result.notes, '- Other')
})
