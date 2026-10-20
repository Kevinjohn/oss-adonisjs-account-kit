import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdir, readFile, writeFile, chmod, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { alive, exists, fixture, until } from '../helpers/pg_service_fixture.mjs'

test('stale PID file after a crashed server does not block stop or test', async (t) => {
  const f = await fixture(t)
  assert.equal((await f.run(['start'])).code, 0)
  const pid = Number(await readFile(join(f.root, 'server-pid'), 'utf8'))
  process.kill(pid, 'SIGKILL')
  await until(() => !alive(pid), 'crashed server exit')
  assert.equal(await exists(join(f.root, 'tmp/pg16/postmaster.pid')), true)
  assert.equal((await f.run(['status'])).code, 3)
  assert.equal((await f.run(['stop'])).code, 0)
  const result = await f.run(['test'])
  assert.equal(result.code, 0, result.output)
  await f.stopped()
})

test('any loopback listener prevents initialization and survives refusal', async (t) => {
  const f = await fixture(t)
  const server = createServer()
  t.after(() => server.close())
  await new Promise((resolve) => server.listen(f.port, '127.0.0.1', resolve))
  const result = await f.run(['start'])
  assert.equal(result.code, 1)
  assert.match(result.output, /is used by another server; set DB_PORT/)
  assert.equal(await exists(join(f.root, 'tmp/pg16')), false)
  assert.equal(server.listening, true)
})

test('failed stop prevents reset deletion', async (t) => {
  const f = await fixture(t)
  assert.equal((await f.run(['start'])).code, 0)
  const sentinel = join(f.root, 'tmp/pg16/keep')
  await writeFile(sentinel, 'preserve')
  await f.control({ stopFail: 47 })
  assert.equal((await f.run(['reset'])).code, 47)
  assert.equal(await readFile(sentinel, 'utf8'), 'preserve')
})

for (const command of ['start', 'stop', 'reset', 'test'])
  test(`${command} loses an overlapping lock without stopping winner`, async (t) => {
    const f = await fixture(t, { testHold: true })
    const winner = f.start(['test'])
    await f.marker('test-ready')
    const owner = await readFile(join(f.root, 'tmp/pg16.lock/owner'), 'utf8')
    const loser = await f.run([command])
    assert.equal(loser.code, 1, loser.output)
    assert.match(loser.output, /cluster lock busy/)
    assert.equal(await readFile(join(f.root, 'tmp/pg16.lock/owner'), 'utf8'), owner)
    assert.equal(await exists(join(f.root, 'stopped')), false)
    winner.child.kill('SIGTERM')
    assert.equal((await winner.done).code, 143)
    await f.stopped()
  })

for (const [signal, code] of [
  ['SIGINT', 130],
  ['SIGTERM', 143],
])
  test(`${signal} terminates runner descendants and stops owned server`, async (t) => {
    const f = await fixture(t, { testHold: true })
    const run = f.start(['test'])
    await f.marker('test-ready')
    const descendant = Number(await readFile(join(f.root, 'descendant'), 'utf8'))
    run.child.kill(signal)
    const result = await run.done
    assert.equal(result.code, code, result.output)
    await until(() => !alive(descendant), 'descendant exit')
    await f.stopped()
  })

test('startup interruption cleans partial start without launching tests', async (t) => {
  const f = await fixture(t, { startHold: true })
  const run = f.start(['test'])
  await f.marker('start-ready')
  run.child.kill('SIGTERM')
  await f.release('start')
  assert.equal((await run.done).code, 143)
  assert.equal(await exists(join(f.root, 'test-environment.json')), false)
  await f.stopped()
})

test('second signal cannot abort database cleanup or replace first signal result', async (t) => {
  const f = await fixture(t, { testHold: true, stopHold: true })
  const run = f.start(['test'])
  await f.marker('test-ready')
  run.child.kill('SIGINT')
  await f.marker('stop-ready')
  run.child.kill('SIGTERM')
  await f.release('stop')
  assert.equal((await run.done).code, 130)
  await f.stopped()
})

test('stale or missing lock owner is never reclaimed', async (t) => {
  const f = await fixture(t)
  const lock = join(f.root, 'tmp/pg16.lock')
  await mkdir(lock, { recursive: true })
  for (const owner of [null, '99999999\n', `${process.pid}\n`]) {
    if (owner === null) await rm(join(lock, 'owner'), { force: true })
    else await writeFile(join(lock, 'owner'), owner)
    assert.equal((await f.run(['reset'])).code, 1)
    assert.equal(await exists(lock), true)
    if (owner !== null) assert.equal(await readFile(join(lock, 'owner'), 'utf8'), owner)
  }
})

for (const status of [1, 2, 5])
  test(`unexpected status ${status} prevents reset deletion`, async (t) => {
    const f = await fixture(t, { status })
    const data = join(f.root, 'tmp/pg16')
    await mkdir(data, { recursive: true })
    await writeFile(join(data, 'keep'), 'safe')
    assert.equal((await f.run(['reset'])).code, 1)
    assert.equal(await readFile(join(data, 'keep'), 'utf8'), 'safe')
  })

test('inaccessible directory fails before reset', async (t) => {
  const f = await fixture(t)
  const data = join(f.root, 'tmp/pg16')
  await mkdir(data, { recursive: true })
  await writeFile(join(data, 'keep'), 'safe')
  await chmod(data, 0o000)
  try {
    assert.equal((await f.run(['reset'])).code, 1)
  } finally {
    await chmod(data, 0o700)
  }
  assert.equal(await readFile(join(data, 'keep'), 'utf8'), 'safe')
})

for (const name of ['tmp', 'tmp/pg16', 'tmp/pg16.log'])
  test(`rejects symlinked ${name} without following target`, async (t) => {
    const f = await fixture(t)
    const target = join(f.root, 'foreign')
    await mkdir(target)
    await writeFile(join(target, 'keep'), 'safe')
    if (name !== 'tmp') await mkdir(join(f.root, 'tmp'))
    await symlink(target, join(f.root, name))
    const result = await f.run(['reset'])
    assert.equal(result.code, 1)
    assert.match(result.output, /symlinked managed path/)
    assert.equal(await readFile(join(target, 'keep'), 'utf8'), 'safe')
  })

for (const variant of [
  'directory',
  'executable',
  'arguments',
  'space suffix',
  'extra arguments',
  'backend title',
  'uninspectable',
])
  test(`foreign ${variant} identity leaves unrelated process alive`, async (t) => {
    const f = await fixture(t)
    assert.equal((await f.run(['start'])).code, 0)
    const pidfile = join(f.root, 'tmp/pg16/postmaster.pid')
    const original = await readFile(pidfile, 'utf8')
    const pid = Number(original.split('\n')[0])
    if (variant === 'directory')
      await writeFile(pidfile, original.replace(join(f.root, 'tmp/pg16'), join(f.root, 'foreign')))
    if (variant === 'executable') await f.control({ foreignExecutable: true })
    if (variant === 'arguments') await f.control({ foreignArgs: join(f.root, 'tmp/pg16-other') })
    if (variant === 'space suffix') await f.control({ foreignArgs: join(f.root, 'tmp/pg16 other') })
    if (variant === 'extra arguments')
      await f.control({ extraArgs: ' -D ' + join(f.root, 'foreign') })
    if (variant === 'backend title') await f.control({ backendTitle: true })
    if (variant === 'uninspectable') await f.control({ uninspectable: true })
    for (const command of ['status', 'start', 'stop', 'reset', 'test']) {
      assert.equal((await f.run([command])).code, 1)
      assert.equal(alive(pid), true)
      assert.equal(
        await readFile(pidfile, 'utf8'),
        variant === 'directory'
          ? original.replace(join(f.root, 'tmp/pg16'), join(f.root, 'foreign'))
          : original
      )
    }
  })

test('PID file referencing unrelated live process is refused', async (t) => {
  const f = await fixture(t, { foreignExecutable: true })
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  })
  t.after(() => unrelated.kill('SIGKILL'))
  const data = join(f.root, 'tmp/pg16')
  await mkdir(data, { recursive: true })
  await writeFile(join(data, 'PG_VERSION'), '16')
  await writeFile(join(data, 'postmaster.pid'), `${unrelated.pid}\n${data}\n0\n${f.port}\n`)
  for (const command of ['status', 'stop', 'reset', 'test']) {
    assert.equal((await f.run([command])).code, 1)
    assert.equal(alive(unrelated.pid), true)
  }
})

test('status 4 with inaccessible complete state prevents reset deletion', async (t) => {
  const f = await fixture(t, { status: 4 })
  const data = join(f.root, 'tmp/pg16')
  await mkdir(data, { recursive: true })
  await writeFile(join(data, 'PG_VERSION'), '16')
  assert.equal((await f.run(['reset'])).code, 1)
  assert.equal(await readFile(join(data, 'PG_VERSION'), 'utf8'), '16')
})

test('TERM-resistant descendant is killed before server shutdown and lock release', async (t) => {
  const f = await fixture(t, { testHold: true, ignoreTerm: true })
  const run = f.start(['test'])
  await f.marker('test-ready')
  const descendant = Number(await readFile(join(f.root, 'descendant'), 'utf8'))
  run.child.kill('SIGTERM')
  const result = await run.done
  assert.equal(result.code, 143, result.output)
  assert.equal(await exists(join(f.root, 'descendant-term-seen')), true)
  await until(() => !alive(descendant), 'TERM-resistant descendant exit')
  await f.stopped()
})

test('ambiguous flattened command cannot disguise a foreign physical data directory', async (t) => {
  const f = await fixture(t)
  const data = join(f.root, 'tmp/pg16')
  const foreign = `${data} -p ${f.port} -c unix_socket_directories= -c listen_addresses=127.0.0.1 -c fsync=off`
  await mkdir(foreign, { recursive: true })
  await f.control({ postgresCwd: foreign })
  assert.equal((await f.run(['start'])).code, 0)
  const pidfile = join(data, 'postmaster.pid')
  const original = await readFile(pidfile, 'utf8')
  const pid = Number(original.split('\n')[0])
  for (const command of ['status', 'start', 'stop', 'reset', 'test']) {
    const result = await f.run([command])
    assert.equal(result.code, 1, result.output)
    assert.match(result.output, /cannot verify postmaster directory/)
    assert.equal(alive(pid), true)
    assert.equal(await readFile(pidfile, 'utf8'), original)
  }
})

test('Linux comm name uses physical executable and directory inspection', async (t) => {
  const f = await fixture(t, { platform: 'linux' })
  const result = await f.run(['test'])
  assert.equal(result.code, 0, result.output)
  await f.stopped()
})

for (const variant of ['executable', 'directory'])
  test(`Linux physical ${variant} mismatch refuses a live foreign process`, async (t) => {
    const f = await fixture(t, { platform: 'linux' })
    assert.equal((await f.run(['start'])).code, 0)
    const pidfile = join(f.root, 'tmp/pg16/postmaster.pid')
    const original = await readFile(pidfile, 'utf8')
    const pid = Number(original.split('\n')[0])
    await f.control(
      variant === 'executable' ? { procExecutable: process.execPath } : { procDirectory: f.root }
    )
    for (const command of ['status', 'start', 'stop', 'reset', 'test']) {
      const result = await f.run([command])
      assert.equal(result.code, 1, result.output)
      assert.match(result.output, /cannot verify postmaster directory/)
      assert.equal(alive(pid), true)
      assert.equal(await readFile(pidfile, 'utf8'), original)
    }
  })

test('unsupported process-inspection platforms fail before mutation', async (t) => {
  const f = await fixture(t, { platform: 'win32' })
  const result = await f.run(['start'])
  assert.equal(result.code, 1)
  assert.match(result.output, /requires macOS or Linux/)
  assert.equal(await exists(join(f.root, 'tmp')), false)
})
