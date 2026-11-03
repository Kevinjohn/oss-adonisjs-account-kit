// A supervised fixture that runs bin/pg.sh against fake PostgreSQL tools.
import assert from 'node:assert/strict'
import { spawn, type ChildProcessByStdio } from 'node:child_process'
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
import type { Readable } from 'node:stream'
import type { TestContext } from '@japa/runner/core'
import { tools } from './pg_service_fake_tools.js'

const source = fileURLToPath(new URL('../../bin/pg.sh', import.meta.url))
export async function exists(path: string) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

export async function until(
  check: () => boolean | Promise<boolean>,
  description: string,
  timeout = 10000
) {
  const deadline = Date.now() + timeout
  while (!(await check())) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${description}`)
    await delay(20)
  }
}

export function alive(pid: number | string | undefined) {
  try {
    process.kill(Number(pid), 0)
    return true
  } catch {
    return false
  }
}

export type FixtureConfig = {
  platform?: string
  [key: string]: string | number | boolean | undefined
}
type RunResult = { code: number | null; signal: NodeJS.Signals | null; output: string }
type RunOptions = { cwd?: string; env?: NodeJS.ProcessEnv }
export async function fixture(t: Pick<TestContext, 'cleanup'>, config: FixtureConfig = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pg service [fixture]-')))
  const bin = join(root, 'bin')
  const children: {
    child: ChildProcessByStdio<null, Readable, Readable>
    done: Promise<RunResult>
  }[] = []
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
  const inspectProcess = Boolean(config.platform) || process.platform === 'linux'
  config = { ...config, platform: config.platform ?? process.platform }
  await writeFile(join(root, 'control.json'), JSON.stringify(config))
  if (inspectProcess) {
    // The fake postgres executable is a Node script, so Linux /proc/exe names Node.
    // Model its PostgreSQL identity while retaining the real inspection checks.
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
  if (proc && fs.readFileSync(path.join(root, 'server-pid'), 'utf8').trim() === proc[1]) {
    process.kill(Number(proc[1]), 0)
    name = proc[2] === 'exe'
      ? config.procExecutable || path.join(root, 'bin/postgres')
      : config.procDirectory || config.postgresCwd || path.join(root, 'tmp/pg16')
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
  await new Promise<void>((resolve, reject) => {
    listener.once('error', reject)
    listener.listen(0, '127.0.0.1', resolve)
  })
  const address = listener.address()
  assert.ok(address && typeof address !== 'string')
  const port = address.port
  await new Promise<void>((resolve) => listener.close(() => resolve()))
  const env = {
    ...process.env,
    PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
    DB_PORT: String(port),
  }
  // Each wrapper has its own group. Bash job control gives its runner a separate
  // group, which is recorded by the fake pnpm before it can create descendants.
  const ownedPids = async () => {
    const groups = new Set(children.flatMap(({ child }) => (child.pid ? [child.pid] : [])))
    const pids = new Set<number>()
    if (await exists(join(root, 'runner-pids'))) {
      for (const line of await readFile(join(root, 'runner-pids'), 'utf8').then((value) =>
        value.trim().split('\n')
      )) {
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
        process.kill(-child.pid!, 'SIGKILL')
      } catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'ESRCH') throw error
      }
    }
    const { groups, pids } = await ownedPids()
    for (const group of groups) {
      try {
        process.kill(-group, 'SIGKILL')
      } catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'ESRCH') throw error
      }
    }
    for (const pid of pids) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'ESRCH') throw error
      }
    }
    return { groups, pids }
  }
  const start = (args: string[], options: RunOptions = {}) => {
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
    let finish!: (result: RunResult) => void
    const done = new Promise<RunResult>((resolve, reject) => {
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
  t.cleanup(async () => {
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
    run: async (args: string[], options?: RunOptions) => start(args, options).done,
    control: async (next: FixtureConfig) => {
      Object.assign(config, next)
      await writeFile(join(root, 'control.json'), JSON.stringify(config))
    },
    marker: (name: string) => until(() => exists(join(root, name)), name),
    release: (name: string) => writeFile(join(root, `${name}-release`), ''),
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
