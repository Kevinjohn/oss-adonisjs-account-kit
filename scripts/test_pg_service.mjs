import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  copyFile,
  chmod,
  rm,
  symlink,
  access,
  realpath,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const source = fileURLToPath(new URL('../bin/pg.sh', import.meta.url))
const tools = `#!${process.execPath}
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const root = path.dirname(path.dirname(process.argv[1]))
const name = path.basename(process.argv[1])
const args = process.argv.slice(2)
const data = path.join(root, 'tmp/pg16')
const pidfile = path.join(data, 'postmaster.pid')
const marker = (name) => fs.writeFileSync(path.join(root, name), '')
const config = JSON.parse(fs.readFileSync(path.join(root, 'control.json'), 'utf8'))
const alive = (pid) => { try { process.kill(Number(pid), 0); return true } catch { return false } }
const pause = async (name) => {
  marker(name + '-ready')
  while (!fs.existsSync(path.join(root, name + '-release'))) await new Promise((resolve) => setTimeout(resolve, 20))
}
const exit = (code) => process.exit(code)
async function main() {
  if (name === 'brew') {
    if (config.noBrew) exit(1)
    console.log(root); return
  }
  if (name === 'ps') {
    const pid = args[args.indexOf('-p') + 1]
    if (!alive(pid) || config.uninspectable) exit(1)
    const record = fs.existsSync(pidfile) ? fs.readFileSync(pidfile, 'utf8').split('\\n') : []
    if (record[0] !== pid || config.foreignExecutable) { console.log('/usr/bin/unrelated'); return }
    const executable = path.join(root, 'bin/postgres')
    const command = executable + ' -D ' + (config.foreignArgs || data) + ' -p ' + record[3] + ' -c unix_socket_directories= -c listen_addresses=127.0.0.1 -c fsync=off'
    console.log(args.includes('comm=') ? config.platform === 'linux' ? 'postgres' : executable : config.backendTitle ? 'postgres: account_kit backend' : command + (config.extraArgs || ''))
    return
  }
  if (name === 'pnpm') {
    fs.appendFileSync(path.join(root, 'runner-pids'), String(process.pid) + '\\n')
    fs.writeFileSync(path.join(root, 'test-environment.json'), JSON.stringify({ env: process.env, args, cwd: process.cwd() }))
    if (config.testHold) {
      const childCode = config.ignoreTerm
        ? 'process.on("SIGTERM", () => require("node:fs").writeFileSync(' + JSON.stringify(path.join(root, 'descendant-term-seen')) + ', "")); require("node:fs").writeFileSync(' + JSON.stringify(path.join(root, 'descendant-ready')) + ', ""); setInterval(() => {}, 1000)'
        : 'setInterval(() => {}, 1000)'
      const child = spawn(process.execPath, ['-e', childCode], { stdio: 'ignore' })
      fs.writeFileSync(path.join(root, 'descendant'), String(child.pid))
      if (config.ignoreTerm) while (!fs.existsSync(path.join(root, 'descendant-ready'))) await new Promise((resolve) => setTimeout(resolve, 20))
      marker('test-ready')
      await new Promise(() => {})
    }
    exit(config.testExit || 0)
  }
  if (name === 'postgres') { setInterval(() => {}, 1000); return }
  if (name === 'pg_ctl' && args[0] === '--version') { console.log('pg_ctl (PostgreSQL) ' + (config.version || '16.15')); return }
  if (Object.keys(process.env).some((key) => key.startsWith('PG') || key.startsWith('DB_'))) exit(91)
  fs.appendFileSync(path.join(root, 'calls'), JSON.stringify({ name, args }) + '\\n')
  if (name === 'initdb') {
    fs.mkdirSync(data, { recursive: true }); fs.writeFileSync(path.join(data, 'PG_VERSION'), '16\\n'); return
  }
  if (name === 'pg_ctl') {
    const action = args[args.length - 1]
    if (action === 'status') {
      if (config.status !== undefined) exit(config.status)
      if (!fs.existsSync(data)) exit(4)
      if (!fs.existsSync(pidfile)) exit(3)
      exit(alive(fs.readFileSync(pidfile, 'utf8').split('\\n')[0]) ? 0 : 3)
    }
    if (action === 'start') {
      const child = spawn(path.join(root, 'bin/postgres'), [], { cwd: config.postgresCwd || data, detached: true, stdio: 'ignore' }); child.unref()
      fs.writeFileSync(path.join(root, 'server-pid'), String(child.pid))
      const options = args[args.indexOf('-o') + 1]
      const port = options.split(' ')[1]
      fs.writeFileSync(pidfile, child.pid + '\\n' + data + '\\n0\\n' + port + '\\n')
      if (config.startHold) await pause('start')
      exit(config.startFail || 0)
    }
    if (action === 'stop') {
      if (config.stopHold) await pause('stop')
      if (config.stopFail) exit(config.stopFail)
      const pid = fs.readFileSync(pidfile, 'utf8').split('\\n')[0]
      process.kill(Number(pid), 'SIGTERM'); fs.unlinkSync(pidfile); marker('stopped'); return
    }
  }
  if (name === 'psql') {
    if (config.queryFail) exit(config.queryFail)
    if (fs.existsSync(path.join(root, 'database'))) console.log('1')
    return
  }
  if (name === 'createdb') {
    if (config.createdbFail) exit(config.createdbFail)
    marker('database'); return
  }
  if (name === 'pg_isready') exit(config.readiness || 0)
}
main().catch((error) => { console.error(error); process.exitCode = 99 })
`

async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function until(check, description, timeout = 10000) {
  const deadline = Date.now() + timeout
  while (!(await check())) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${description}`)
    await delay(20)
  }
}

function alive(pid) {
  try {
    process.kill(Number(pid), 0)
    return true
  } catch {
    return false
  }
}

async function fixture(t, config = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pg service [fixture]-')))
  const bin = join(root, 'bin')
  const children = []
  await mkdir(bin)
  await mkdir(join(root, 'tests'))
  await copyFile(source, join(bin, 'pg.sh'))
  for (const name of [
    'brew',
    'pg_ctl',
    'postgres',
    'initdb',
    'pg_isready',
    'psql',
    'createdb',
    'ps',
    'pnpm',
  ]) {
    await writeFile(join(bin, name), tools)
    await chmod(join(bin, name), 0o755)
  }
  await writeFile(join(root, 'control.json'), JSON.stringify(config))
  if (config.platform) {
    // Exercise the real inline inspection code with fake platform observations.
    const preload = join(root, 'process_inspection.cjs')
    await writeFile(
      preload,
      `
const fs = require('node:fs')
const path = require('node:path')
const root = __dirname
const config = JSON.parse(fs.readFileSync(path.join(root, 'control.json'), 'utf8'))
const realpath = fs.realpathSync
Object.defineProperty(process, 'platform', { value: config.platform })
fs.realpathSync = (name, ...options) => {
  const proc = /^\\/proc\\/([0-9]+)\\/(exe|cwd)$/.exec(String(name))
  if (proc) {
    process.kill(Number(proc[1]), 0)
    name = proc[2] === 'exe'
      ? config.procExecutable || path.join(root, 'bin/postgres')
      : config.procDirectory || path.join(root, 'tmp/pg16')
  }
  return realpath(name, ...options)
}
`
    )
    await writeFile(
      join(bin, 'node'),
      `#!${process.execPath}
const { spawnSync } = require('node:child_process')
const result = spawnSync(process.execPath, ['--require', ${JSON.stringify(preload)}, ...process.argv.slice(2)], { stdio: 'inherit' })
process.exit(result.status === null ? 1 : result.status)
`
    )
    await chmod(join(bin, 'node'), 0o755)
  }
  const listener = createServer()
  await new Promise((resolve, reject) => {
    listener.once('error', reject)
    listener.listen(0, '127.0.0.1', resolve)
  })
  const port = listener.address().port
  await new Promise((resolve) => listener.close(resolve))
  const env = {
    ...process.env,
    PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
    DB_PORT: String(port),
  }
  // Each wrapper has its own group. Bash job control gives its runner a separate
  // group, which is recorded by the fake pnpm before it can create descendants.
  const ownedPids = async () => {
    const groups = new Set(children.map(({ child }) => child.pid))
    const pids = new Set()
    if (await exists(join(root, 'runner-pids'))) {
      for (const line of (await readFile(join(root, 'runner-pids'), 'utf8')).trim().split('\n')) {
        const pid = Number(line)
        if (Number.isSafeInteger(pid) && pid > 1) groups.add(pid)
      }
    }
    for (const file of ['server-pid', 'descendant']) {
      if (await exists(join(root, file))) {
        const pid = Number(await readFile(join(root, file), 'utf8'))
        if (Number.isSafeInteger(pid) && pid > 1) pids.add(pid)
      }
    }
    return { groups, pids }
  }
  const terminateOwned = async () => {
    // Stop wrappers first so no new runner group can appear after the PID snapshot.
    for (const { child } of children) {
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch (error) {
        if (error.code !== 'ESRCH') throw error
      }
    }
    const { groups, pids } = await ownedPids()
    for (const group of groups) {
      try {
        process.kill(-group, 'SIGKILL')
      } catch (error) {
        if (error.code !== 'ESRCH') throw error
      }
    }
    for (const pid of pids) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch (error) {
        if (error.code !== 'ESRCH') throw error
      }
    }
    return { groups, pids }
  }
  const start = (args, options = {}) => {
    const child = spawn('/bin/bash', [join(bin, 'pg.sh'), ...args], {
      cwd: options.cwd || root,
      env: { ...env, ...options.env },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    let timedOut = false
    child.stdout.on('data', (data) => {
      output += data
    })
    child.stderr.on('data', (data) => {
      output += data
    })
    let finish
    const done = new Promise((resolve, reject) => {
      finish = resolve
      child.once('error', reject)
      child.once('close', (code, signal) =>
        resolve({ code: timedOut ? 124 : code, signal, output })
      )
    })
    const timer = setTimeout(async () => {
      timedOut = true
      output += '\nfixture wrapper exceeded its 20-second deadline\n'
      try {
        await terminateOwned()
      } catch (error) {
        output += String(error)
      }
      // Closing inherited streams also bounds completion if a broken wrapper left
      // an unrecorded process holding a pipe; teardown still verifies tracked PIDs.
      child.stdout.destroy()
      child.stderr.destroy()
      finish({ code: 124, signal: null, output })
    }, 20000)
    void done.then(
      () => clearTimeout(timer),
      () => clearTimeout(timer)
    )
    children.push({ child, done })
    return { child, done }
  }
  t.after(async () => {
    const { groups, pids } = await terminateOwned()
    try {
      await until(
        () => [...groups].every((pid) => !alive(-pid)) && [...pids].every((pid) => !alive(pid)),
        'fixture process cleanup',
        5000
      )
      await until(
        () => children.every(({ child }) => child.exitCode !== null || child.signalCode !== null),
        'wrapper reaping',
        5000
      )
      for (const { child } of children) {
        child.stdout.destroy()
        child.stderr.destroy()
      }
      await Promise.all(children.map(({ done }) => done))
    } finally {
      for (const { child } of children) {
        child.stdout.destroy()
        child.stderr.destroy()
      }
      await rm(root, { recursive: true, force: true })
    }
  })
  return {
    root,
    bin,
    port,
    env,
    start,
    run: async (args, options) => start(args, options).done,
    control: async (next) => {
      Object.assign(config, next)
      await writeFile(join(root, 'control.json'), JSON.stringify(config))
    },
    marker: (name) => until(() => exists(join(root, name)), name),
    release: (name) => writeFile(join(root, `${name}-release`), ''),
    stopped: async () => {
      assert.equal(await exists(join(root, 'tmp/pg16/postmaster.pid')), false)
      assert.equal(await exists(join(root, 'tmp/pg16.lock')), false)
      if (await exists(join(root, 'server-pid'))) {
        const pid = Number(await readFile(join(root, 'server-pid'), 'utf8'))
        await until(() => !alive(pid), 'server exit')
      }
    },
  }
}

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

test('readiness failure cannot change owned running status', async (t) => {
  const f = await fixture(t)
  assert.equal((await f.run(['start'])).code, 0)
  await f.control({ readiness: 2 })
  assert.equal((await f.run(['status'])).code, 0)
  assert.equal((await f.run(['stop'])).code, 0)
})

test('status 4 with inaccessible complete state prevents reset deletion', async (t) => {
  const f = await fixture(t, { status: 4 })
  const data = join(f.root, 'tmp/pg16')
  await mkdir(data, { recursive: true })
  await writeFile(join(data, 'PG_VERSION'), '16')
  assert.equal((await f.run(['reset'])).code, 1)
  assert.equal(await readFile(join(data, 'PG_VERSION'), 'utf8'), '16')
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
