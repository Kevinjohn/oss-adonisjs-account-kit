// Fake PostgreSQL tools and a supervised fixture that runs bin/pg.sh against them.
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
  access,
  realpath,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const source = fileURLToPath(new URL('../../bin/pg.sh', import.meta.url))
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

export async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

export async function until(check, description, timeout = 10000) {
  const deadline = Date.now() + timeout
  while (!(await check())) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${description}`)
    await delay(20)
  }
}

export function alive(pid) {
  try {
    process.kill(Number(pid), 0)
    return true
  } catch {
    return false
  }
}

export async function fixture(t, config = {}) {
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
