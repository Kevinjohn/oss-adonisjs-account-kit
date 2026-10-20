import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmod, readFile, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { alive, exists, fixture, until } from '../helpers/pg_service_fixture.mjs'

test('PATH binaries work when Homebrew is unavailable; wrong major fails', async (t) => {
  const f = await fixture(t, { noBrew: true })
  assert.equal((await f.run(['test'])).code, 0)
  await f.control({ version: '17.1' })
  const result = await f.run(['start'])
  assert.equal(result.code, 1)
  assert.match(result.output, /PostgreSQL 16 not found/)
})

for (const port of ['0', '65536', '-1', 'abc', '1; touch invalid', '999999999999999999999999999'])
  test(`rejects invalid port ${port}`, async (t) => {
    const f = await fixture(t)
    const result = await f.run(['start'], { env: { DB_PORT: port } })
    assert.equal(result.code, 1)
    assert.equal(await exists(join(f.root, 'tmp')), false)
  })

for (const args of [
  [],
  ['unknown'],
  ['start', 'extra'],
  ['stop', 'extra'],
  ['status', 'extra'],
  ['reset', 'extra'],
])
  test(`validates command ${JSON.stringify(args)} before mutation`, async (t) => {
    const f = await fixture(t)
    assert.equal((await f.run(args)).code, 1)
    assert.equal(await exists(join(f.root, 'tmp')), false)
  })

test('missing companion executable fails with installation guidance', async (t) => {
  const f = await fixture(t)
  await rm(join(f.bin, 'createdb'))
  const result = await f.run(['start'])
  assert.equal(result.code, 1)
  assert.match(result.output, /PostgreSQL 16 not found/)
  assert.equal(await exists(join(f.root, 'tmp')), false)
})

test('wrong Node version fails before managed state is created', async (t) => {
  const f = await fixture(t)
  await writeFile(join(f.bin, 'node'), '#!/bin/sh\nexit 1\n')
  await chmod(join(f.bin, 'node'), 0o755)
  const result = await f.run(['start'])
  assert.equal(result.code, 1)
  assert.match(result.output, /Use Node 24: nvm use/)
  assert.equal(await exists(join(f.root, 'tmp')), false)
})

test('leading-zero DB_PORT is normalized to decimal for startup and reuse', async (t) => {
  const f = await fixture(t)
  const options = { env: { DB_PORT: `0${f.port}` } }
  const started = await f.run(['start'], options)
  assert.equal(started.code, 0, started.output)
  const pidfile = await readFile(join(f.root, 'tmp/pg16/postmaster.pid'), 'utf8')
  assert.equal(pidfile.split('\n')[3], String(f.port))
  const repeated = await f.run(['start'], options)
  assert.equal(repeated.code, 0, repeated.output)
  assert.match(repeated.output, /already running/)
  assert.equal((await f.run(['stop'])).code, 0)
  await f.stopped()
})
