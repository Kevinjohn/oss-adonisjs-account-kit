import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test } from '@japa/runner'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const consumerHarness = join(repoRoot, 'scripts/test_packed_consumer.mjs')

test('rejects minimum compatibility for modes that do not support it before setup', ({
  assert,
}) => {
  for (const mode of ['fresh', 'service-only']) {
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
