import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test } from '@japa/runner'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))

test('consumer gitignore hides dotenv files while keeping the example template visible', async ({
  assert,
}) => {
  const root = await mkdtemp(join(tmpdir(), 'account-kit-consumer-ignore-'))
  try {
    await writeFile(
      join(root, '.gitignore'),
      await readFile(join(repoRoot, 'examples/api/.gitignore'))
    )
    const dotenvFiles = ['.env', '.env.local', '.env.production', '.env.test', '.env.staging']
    await Promise.all(dotenvFiles.map((file) => writeFile(join(root, file), '')))
    await writeFile(join(root, '.env.example'), '')
    const initialized = spawnSync('git', ['init', '--quiet'], { cwd: root })
    assert.equal(initialized.status, 0)
    const ignored = dotenvFiles.map((file) =>
      spawnSync('git', ['check-ignore', '--quiet', file], { cwd: root })
    )
    const example = spawnSync('git', ['check-ignore', '--quiet', '.env.example'], { cwd: root })

    assert.deepEqual(
      ignored.map(({ status }) => status),
      [0, 0, 0, 0, 0]
    )
    assert.equal(example.status, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
