import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
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

test('fresh consumer copies exclude local databases, secrets and installed artifacts', async ({
  assert,
}) => {
  const directory = await mkdtemp(join(tmpdir(), 'account-kit-fixture-copy-'))
  const source = join(directory, 'source')
  const destination = join(directory, 'consumer')
  const localFiles = [
    'tmp/db.sqlite3',
    'node_modules/local-package/index.js',
    'build/server.js',
    'vendor/local-package.tgz',
    '.adonisjs/client/registry.ts',
    '.env',
    '.env.local',
  ]
  try {
    for (const filename of localFiles) {
      const path = join(source, filename)
      await mkdir(join(path, '..'), { recursive: true })
      await writeFile(path, 'local fixture state')
    }
    await mkdir(join(source, 'app/tmp'), { recursive: true })
    await writeFile(join(source, 'app/tmp/owned.ts'), 'application source')
    await writeFile(join(source, '.env.example'), 'NODE_ENV=development')
    await writeFile(join(source, 'package.json'), '{"private":true}')

    const copyModule = new URL('../scripts/consumer/fixture.mjs', import.meta.url).href
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import { copyFixture } from ${JSON.stringify(copyModule)}; await copyFixture(process.argv[1], process.argv[2])`,
        source,
        destination,
      ],
      { encoding: 'utf8' }
    )
    assert.equal(result.status, 0, result.stderr)
    for (const filename of localFiles) {
      assert.isFalse(existsSync(join(destination, filename)), `${filename} must remain local`)
      assert.equal(await readFile(join(source, filename), 'utf8'), 'local fixture state')
    }
    assert.equal(
      await readFile(join(destination, 'app/tmp/owned.ts'), 'utf8'),
      'application source'
    )
    assert.equal(await readFile(join(destination, '.env.example'), 'utf8'), 'NODE_ENV=development')
    assert.equal(await readFile(join(destination, 'package.json'), 'utf8'), '{"private":true}')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
