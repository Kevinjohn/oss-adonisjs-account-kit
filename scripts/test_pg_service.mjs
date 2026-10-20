import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdir, readFile, writeFile, chmod, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { alive, exists, fixture, until } from './helpers/pg_service_fixture.mjs'

test('managed test succeeds, forwards selectors, isolates environment and runs at root', async (t) => {
  const f = await fixture(t)
  const result = await f.run(['test', '--files=db.spec.ts'], {
    cwd: join(f.root, 'tests'),
    env: {
      PGDATA: '/nonexistent',
      PGHOSTADDR: '192.0.2.1',
      PGSERVICE: 'hostile',
      PGSSLMODE: 'require',
      PGSSLNEGOTIATION: 'direct',
      PGOPTIONS: 'invalid',
      DB_HOST: 'hostile',
      DB_USER: 'other',
      DB_DATABASE: 'other',
      KEEP_ME: 'yes',
    },
  })
  assert.equal(result.code, 0, result.output)
  const observed = JSON.parse(await readFile(join(f.root, 'test-environment.json'), 'utf8'))
  assert.equal(observed.cwd, f.root)
  assert.deepEqual(observed.args, ['quick:test', '--files=db.spec.ts'])
  assert.deepEqual(
    Object.keys(observed.env).filter((key) => key.startsWith('PG')),
    []
  )
  for (const [key, value] of Object.entries({
    DB_CLIENT: 'pg',
    DB_HOST: '127.0.0.1',
    DB_PORT: String(f.port),
    DB_USER: 'account_kit',
    DB_PASSWORD: '',
    DB_DATABASE: 'account_kit_test',
    KEEP_ME: 'yes',
  }))
    assert.equal(observed.env[key], value)
  await f.stopped()
  assert.equal((await f.run(['status'])).code, 3)
})

for (const [name, config, expected] of [
  ['distinctive test failure', { testExit: 42 }, 42],
  ['partial start failure', { startFail: 43 }, 43],
  ['database creation failure', { createdbFail: 44 }, 44],
  ['database query failure', { queryFail: 45 }, 45],
  ['shutdown failure after success', { stopFail: 46 }, 1],
  ['primary and shutdown failure', { testExit: 42, stopFail: 46 }, 42],
])
  test(name, async (t) => {
    const f = await fixture(t, config)
    const result = await f.run(['test'])
    assert.equal(result.code, expected, result.output)
    assert.equal(await exists(join(f.root, 'tmp/pg16.lock')), false)
    if (config.stopFail) {
      assert.match(result.output, /cleanup failed/)
      assert.equal(await exists(join(f.root, 'tmp/pg16/postmaster.pid')), true)
    } else await f.stopped()
  })

test('standalone cluster is preserved, actual port checked and stop is idempotent', async (t) => {
  const f = await fixture(t)
  assert.equal((await f.run(['start'])).code, 0)
  const again = await f.run(['start'])
  assert.equal(again.code, 0, again.output)
  assert.match(again.output, /already running/)
  const refusal = await f.run(['test'])
  assert.equal(refusal.code, 1)
  assert.match(refusal.output, /cluster already running: use pnpm pg:stop/)
  const different = await f.run(['start'], {
    env: { DB_PORT: String(f.port === 65535 ? 65534 : f.port + 1) },
  })
  assert.equal(different.code, 1)
  assert.match(different.output, new RegExp(`port ${f.port}`))
  assert.equal((await f.run(['status'])).code, 0)
  assert.equal((await f.run(['stop'])).code, 0)
  assert.equal((await f.run(['stop'])).code, 0)
  await f.stopped()
})

for (const variant of ['wrong version', 'incomplete'])
  test(`reset recovers ${variant} data`, async (t) => {
    const f = await fixture(t)
    const data = join(f.root, 'tmp/pg16')
    await mkdir(data, { recursive: true })
    await writeFile(
      join(data, variant === 'wrong version' ? 'PG_VERSION' : 'unfinished'),
      variant === 'wrong version' ? '16.9' : 'keep'
    )
    const result = await f.run(['start'])
    assert.equal(result.code, 1)
    assert.match(result.output, /bash bin\/pg.sh reset/)
    assert.equal((await f.run(['reset'])).code, 0)
    assert.equal((await readFile(join(data, 'PG_VERSION'), 'utf8')).trim(), '16')
    assert.equal((await f.run(['stop'])).code, 0)
  })

test('readiness failure cannot change owned running status', async (t) => {
  const f = await fixture(t)
  assert.equal((await f.run(['start'])).code, 0)
  await f.control({ readiness: 2 })
  assert.equal((await f.run(['status'])).code, 0)
  assert.equal((await f.run(['stop'])).code, 0)
})
