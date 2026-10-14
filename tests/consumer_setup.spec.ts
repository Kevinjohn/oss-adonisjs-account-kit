import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test } from '@japa/runner'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const consumerHarness = join(repoRoot, 'scripts/test_packed_consumer.mjs')

test('rejects minimum compatibility for modes that do not support it before setup', ({
  assert,
}) => {
  for (const mode of ['fresh', 'upgrade', 'both']) {
    const result = spawnSync(
      process.execPath,
      [
        consumerHarness,
        `--mode=${mode}`,
        '--compatibility=minimum',
        '--candidate-tarball=/does/not/exist.tgz',
      ],
      { cwd: repoRoot, encoding: 'utf8' }
    )

    assert.notEqual(result.status, 0)
    assert.include(result.stderr, '--compatibility=minimum requires --mode=minimum')
    assert.notInclude(result.stdout + result.stderr, 'Consumer run directory:')
  }
})

test('keeps minimum mode restricted to minimum compatibility', ({ assert }) => {
  const result = spawnSync(
    process.execPath,
    [consumerHarness, '--mode=minimum', '--compatibility=latest'],
    { cwd: repoRoot, encoding: 'utf8' }
  )

  assert.notEqual(result.status, 0)
  assert.include(result.stderr, '--mode=minimum requires --compatibility=minimum')
  assert.notInclude(result.stdout + result.stderr, 'Consumer run directory:')
})

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
