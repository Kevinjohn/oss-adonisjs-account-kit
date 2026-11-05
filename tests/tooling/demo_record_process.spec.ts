import { test } from '@japa/runner'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile, chmod, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { starterAce, starterConsole } from '../../bin/demos/starter_contract.js'
import { writeDemoIdentity } from '../../bin/demos/demo_identity.js'
import { recordingFailure, stopServer } from '../../bin/demos/record.js'

const rootDir = fileURLToPath(new URL('../../', import.meta.url))
const recorder = join(rootDir, 'bin/demos/record.ts')

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'account-kit-record-process-'))
  const bin = join(root, 'bin')
  const app = join(root, 'app')
  const output = join(root, 'casts')
  await Promise.all([mkdir(bin), mkdir(app)])
  await Promise.all([mkdir(join(app, 'config')), mkdir(join(app, 'tmp'))])
  await writeFile(
    join(app, 'package.json'),
    JSON.stringify({
      name: 'fake-demo-app',
      dependencies: {
        '@adonisjs/core': '^7.0.0',
        '@adonisjs/lucid': '^22.0.0',
        'better-sqlite3': '^13.0.0',
      },
    })
  )
  await mkdir(join(app, 'bin'))
  await writeFile(join(app, 'ace.js'), starterAce)
  await writeFile(join(app, 'bin/console.ts'), starterConsole)
  await writeFile(
    join(app, 'adonisrc.ts'),
    "import { defineConfig } from '@adonisjs/core/app'\nexport default defineConfig({})"
  )
  await writeFile(
    join(app, 'config/database.ts'),
    `import { defineConfig } from '@adonisjs/lucid'
import app from '@adonisjs/core/services/app'
const dbConfig = defineConfig({
  connection: 'sqlite',
  connections: { sqlite: { client: 'better-sqlite3', connection: { filename: app.tmpPath('db.sqlite3') }, useNullAsDefault: true, migrations: { naturalSort: true, paths: ['database/migrations'] }, schemaGeneration: { enabled: true, rulesPaths: ['database/schema_rules.js'] } } },
})
export default dbConfig
`
  )
  writeDemoIdentity(app, 'feature-recording')
  const fakeCommand = `#!${process.execPath}
const fs = require('node:fs')
const { spawn } = require('node:child_process')
const args = process.argv.slice(2)
const kind = process.env.FAKE_CURL === '1' ? 'curl' : args[1] === 'migration:fresh' ? 'migration' : args[1] === 'serve' ? 'server' : 'doctor'
const trace = (line) => fs.appendFileSync(process.env.TRACE, line + '\\n')
if (kind === 'server') {
  trace('server-spawned')
  if (process.env.FAIL_START === '1') { trace(kind + '-entered:' + process.pid); console.error('startup-failure'); process.exit(9) }
  if (process.env.HOLD_START !== '1') { console.log('started HTTP server'); trace('server-ready') }
}
if ((kind === 'server' && process.env.IGNORE_TERM === '1') || (process.env.HOLD_COMMAND === kind && process.env.RESIST_COMMAND === '1')) {
  const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  fs.writeFileSync(process.env.TRACE + '.descendant', String(descendant.pid))
  trace('descendant:' + descendant.pid)
}
if (kind === 'server' || process.env.HOLD_COMMAND === kind) {
  process.on('SIGTERM', () => {
    trace(kind + '-term')
    if ((kind === 'server' && process.env.IGNORE_TERM === '1') || process.env.RESIST_COMMAND === '1') return
    trace('cleaned'); process.exit(0)
  })
  setInterval(() => {}, 1000)
} else {
  if (kind === 'doctor') console.log('healthy')
  if (kind === 'curl') console.log('\\n200')
}
trace(kind + '-entered:' + process.pid)
`
  await writeFile(join(bin, 'node'), fakeCommand)
  await writeFile(join(bin, 'curl'), fakeCommand.replace("process.env.FAKE_CURL === '1'", 'true'))
  await writeFile(
    join(bin, 'lsof'),
    `#!/bin/sh
count=0
if [ -f "$LSOF_CALLS" ]; then count=$(cat "$LSOF_CALLS"); fi
count=$((count + 1))
echo "$count" > "$LSOF_CALLS"
if [ "$count" -gt 1 ] && [ -n "${'${UNRELATED_PID:-}'}" ]; then echo "$UNRELATED_PID"; fi
`
  )
  await Promise.all([
    chmod(join(bin, 'node'), 0o755),
    chmod(join(bin, 'curl'), 0o755),
    chmod(join(bin, 'lsof'), 0o755),
  ])
  // Fixtures own their database settings; refusal cases inject overrides explicitly.
  const env = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        ([name]) => !/^(?:DB_|DATABASE_)/i.test(name) && name !== 'NODE_OPTIONS'
      )
    ),
    PATH: `${bin}:${process.env.PATH}`,
    TRACE: join(root, 'trace'),
    LSOF_CALLS: join(root, 'lsof-calls'),
  }
  const start = (args: string[], extra: NodeJS.ProcessEnv = {}, preload?: string) => {
    const child = spawn(
      process.execPath,
      [
        '--import=@poppinss/ts-exec',
        ...(preload ? ['--import', preload] : []),
        recorder,
        app,
        output,
        ...args,
      ],
      { cwd: rootDir, env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] }
    )
    let outputText = ''
    child.stdout!.on('data', (value) => (outputText += value))
    child.stderr!.on('data', (value) => (outputText += value))
    const done = new Promise<{ code: number | null; output: string }>((resolve) => {
      child.once('close', (code) => resolve({ code, output: outputText }))
    })
    return { child, done }
  }
  return {
    root,
    output,
    trace: join(root, 'trace'),
    start,
    cleanup: () => rm(root, { recursive: true, force: true }),
  }
}

async function until(check: () => Promise<boolean>, description: string) {
  const deadline = Date.now() + 5000
  while (!(await check().catch(() => false))) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${description}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

test.group('demo recording process ownership', (group) => {
  group.each.timeout(30_000)

  test('startup failure cleans the spawned child and reports the startup error', async (t) => {
    const f = await fixture()
    t.cleanup(f.cleanup)
    const result = await f.start(['doctor'], { FAIL_START: '1' }).done
    assert.equal(result.code, 1, result.output)
    assert.match(result.output, /server did not start|server exited before readiness/)
    const trace = await readFile(f.trace, 'utf8')
    assert.match(trace, /migration/)
    assert.match(trace, /server-spawned/)
  })

  test('scenario failure retains its error and completes owned process cleanup', async (t) => {
    const f = await fixture()
    t.cleanup(f.cleanup)
    const result = await f.start(['missing-scenario']).done
    assert.equal(result.code, 1, result.output)
    assert.match(result.output, /scenarios\[name\] is not a function/)
    await until(async () => {
      const trace = await readFile(f.trace, 'utf8')
      return trace.includes('cleaned')
    }, 'server cleanup')
  })

  test('normal completion waits for owned server cleanup', async (t) => {
    const f = await fixture()
    t.cleanup(f.cleanup)
    const result = await f.start(['doctor']).done
    assert.equal(result.code, 0, result.output)
    const trace = await readFile(f.trace, 'utf8')
    assert.equal(trace.includes('cleaned'), true)
  })

  test('an unrelated listener reported by a simulated port probe remains alive', async (t) => {
    const f = await fixture()
    t.cleanup(f.cleanup)
    const unrelated = spawn(
      process.execPath,
      [
        '-e',
        "const server = require('node:net').createServer(); server.listen(0, '127.0.0.1', () => console.log('ready'))",
      ],
      { stdio: ['ignore', 'pipe', 'ignore'] }
    )
    t.cleanup(async () => {
      unrelated.kill('SIGTERM')
      if (unrelated.exitCode === null && unrelated.signalCode === null)
        await new Promise<void>((resolve) => unrelated.once('close', () => resolve()))
    })
    await new Promise<void>((resolve, reject) => {
      unrelated.stdout!.once('data', () => resolve())
      unrelated.once('error', reject)
    })
    const result = await f.start(['doctor'], { UNRELATED_PID: String(unrelated.pid) }).done
    assert.equal(result.code, 0, result.output)
    assert.equal(unrelated.exitCode, null)
  })

  test('SIGTERM during startup prevents scenario work and returns 143 after cleanup', async (t) => {
    const f = await fixture()
    t.cleanup(f.cleanup)
    const run = f.start(['doctor'], { HOLD_START: '1' })
    await until(async () => {
      const trace = await readFile(f.trace, 'utf8')
      return trace.includes('server-spawned')
    }, 'server spawn')
    run.child.kill('SIGTERM')
    const result = await run.done
    assert.equal(result.code, 143, result.output)
    const trace = await readFile(f.trace, 'utf8')
    assert.equal((trace.match(/migration/g) ?? []).length, 1)
    assert.equal(trace.includes('cleaned'), true)
  })

  for (const kind of ['migration', 'doctor', 'curl']) {
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      test(`${signal} interrupts pending ${kind} after its command barrier`, async (t) => {
        const f = await fixture()
        t.cleanup(f.cleanup)
        const run = f.start([kind === 'curl' ? 'signup-verification' : 'doctor', 'doctor'], {
          HOLD_COMMAND: kind,
        })
        await until(async () => {
          const trace = await readFile(f.trace, 'utf8')
          return trace.includes(`${kind}-entered:`)
        }, `${kind} command entered`)
        const started = Date.now()
        run.child.kill(signal)
        const result = await run.done
        assert.equal(result.code, signal === 'SIGINT' ? 130 : 143, result.output)
        assert.ok(Date.now() - started < 11000, result.output)
        const trace = await readFile(f.trace, 'utf8')
        assert.equal((trace.match(/migration-entered:/g) ?? []).length, 1)
        assert.equal((trace.match(new RegExp(`${kind}-entered:`, 'g')) ?? []).length, 1)
        for (const match of trace.matchAll(/-entered:(\d+)/g))
          assert.throws(() => process.kill(Number(match[1]), 0), { code: 'ESRCH' })
        assert.doesNotMatch(result.output, /UnhandledPromiseRejection/)
        assert.deepEqual(await readdir(f.output), [])
      })
    }
  }

  for (const kind of ['migration', 'doctor', 'curl']) {
    test(`second signal immediately escalates pending ${kind} after its TERM barrier`, async (t) => {
      const f = await fixture()
      t.cleanup(f.cleanup)
      const run = f.start([kind === 'curl' ? 'signup-verification' : 'doctor', 'doctor'], {
        HOLD_COMMAND: kind,
        RESIST_COMMAND: '1',
        IGNORE_TERM: '1',
      })
      await until(async () => {
        const trace = await readFile(f.trace, 'utf8')
        return trace.includes(`${kind}-entered:`)
      }, `${kind} entered`)
      run.child.kill('SIGINT')
      await until(async () => {
        const trace = await readFile(f.trace, 'utf8')
        return (
          trace.includes(`${kind}-term`) && (kind === 'migration' || trace.includes('server-term'))
        )
      }, 'command and server TERM handlers')
      const started = Date.now()
      run.child.kill('SIGTERM')
      const result = await run.done
      assert.equal(result.code, 130, result.output)
      assert.ok(Date.now() - started < 3000, result.output)
      const trace = await readFile(f.trace, 'utf8')
      assert.equal((trace.match(/migration-entered:/g) ?? []).length, 1)
      for (const match of trace.matchAll(/(?:-entered|descendant):(\d+)/g))
        assert.throws(() => process.kill(Number(match[1]), 0), { code: 'ESRCH' })
      const descendant = Number(await readFile(`${f.trace}.descendant`, 'utf8'))
      assert.throws(() => process.kill(descendant, 0), { code: 'ESRCH' })
      assert.doesNotMatch(result.output, /UnhandledPromiseRejection/)
    })
  }

  test('TERM resistant descendant is killed and the process group is reaped', async (t) => {
    const f = await fixture()
    t.cleanup(f.cleanup)
    const result = await f.start(['doctor'], { IGNORE_TERM: '1' }).done
    assert.equal(result.code, 0, result.output)
    const descendant = Number(await readFile(`${f.trace}.descendant`, 'utf8'))
    assert.throws(() => process.kill(descendant, 0), { code: 'ESRCH' })
  })

  for (const mode of ['completion', 'startup', 'signal']) {
    test(`CLI failed reap settles with referenced handles during ${mode}`, async (t) => {
      const startupFailure = mode === 'startup'
      const f = await fixture()
      t.cleanup(f.cleanup)
      const preload = join(f.root, 'reap_probe.mjs')
      await writeFile(
        preload,
        `
import cp from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { appendFileSync } from 'node:fs'
const originalSpawn = cp.spawn
const originalKill = process.kill.bind(process)
let serverPid
cp.spawn = (...args) => {
  const child = originalSpawn(...args)
  if (args[1]?.[1] === 'serve') {
    serverPid = child.pid
    // Model a referenced child/pipe handle surviving the failed final probe.
    const reference = setInterval(() => {}, 1000)
    const originalUnref = child.unref.bind(child)
    child.unref = () => { clearInterval(reference); appendFileSync(process.env.TRACE, 'released-handle\\n'); return originalUnref() }
    for (const stream of [child.stdout, child.stderr]) {
      const destroy = stream.destroy.bind(stream)
      stream.destroy = (...values) => { appendFileSync(process.env.TRACE, 'released-stream\\n'); return destroy(...values) }
    }
  }
  return child
}
process.kill = (pid, signal) => {
  if (pid === -serverPid && signal === 0) return true
  return originalKill(pid, signal)
}
syncBuiltinESMExports()
`
      )
      const started = Date.now()
      const run = f.start(
        ['doctor'],
        startupFailure ? { FAIL_START: '1' } : mode === 'signal' ? { HOLD_COMMAND: 'doctor' } : {},
        preload
      )
      if (mode === 'signal') {
        await until(async () => {
          const trace = await readFile(f.trace, 'utf8')
          return trace.includes('doctor-entered:')
        }, 'pending doctor before failed-reap interruption')
        run.child.kill('SIGINT')
      }
      const result = await run.done
      assert.equal(result.code, mode === 'signal' ? 130 : 1, result.output)
      assert.ok(Date.now() - started < 13000, result.output)
      assert.match(result.output, /did not exit after SIGKILL/)
      if (startupFailure) {
        assert.match(result.output, /server exited before readiness/)
        assert.match(result.output, /recording failed and cleanup also failed/)
      }
      assert.doesNotMatch(result.output, /UnhandledPromiseRejection/)
      const trace = await readFile(f.trace, 'utf8')
      assert.match(trace, /released-handle/)
      assert.match(trace, /released-stream/)
      for (const match of trace.matchAll(/-entered:(\d+)/g))
        assert.throws(() => process.kill(Number(match[1]), 0), { code: 'ESRCH' })
    })
  }

  test('a failed command reap is reported once', async (t) => {
    const f = await fixture()
    t.cleanup(f.cleanup)
    const preload = join(f.root, 'command_reap_probe.mjs')
    await writeFile(
      preload,
      `
import cp from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
const originalSpawn = cp.spawn
const originalKill = process.kill.bind(process)
let migrationPid
cp.spawn = (...args) => {
  const child = originalSpawn(...args)
  if (args[1]?.[1] === 'migration:fresh') migrationPid = child.pid
  return child
}
process.kill = (pid, signal) => {
  if (pid === -migrationPid && signal === 0) return true
  return originalKill(pid, signal)
}
syncBuiltinESMExports()
`
    )
    const result = await f.start(['doctor'], {}, preload).done
    assert.equal(result.code, 1, result.output)
    assert.equal(result.output.match(/did not exit after SIGKILL/g)?.length, 1, result.output)
  })

  test('interrupted never-ready child cancels readiness even when exit and reap stay pending', async (t) => {
    const f = await fixture()
    t.cleanup(f.cleanup)
    const preload = join(f.root, 'pending_startup.mjs')
    await writeFile(
      preload,
      `
import cp from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { appendFileSync } from 'node:fs'
const spawn = cp.spawn
const kill = process.kill.bind(process)
const pendingPid = 498765
const trace = (line) => appendFileSync(process.env.TRACE, line + '\\n')
cp.spawn = (...args) => {
  if (args[1]?.[1] !== 'serve') return spawn(...args)
  const child = new EventEmitter()
  child.pid = pendingPid
  child.exitCode = child.signalCode = null
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  const reference = setInterval(() => {}, 1000)
  child.unref = () => { clearInterval(reference); trace('pending-handle-released') }
  trace('never-ready-child-created')
  return child
}
process.kill = (pid, signal) => {
  if (pid !== -pendingPid) return kill(pid, signal)
  if (signal) trace('pending-child-' + signal)
  return true
}
syncBuiltinESMExports()
`
    )
    const run = f.start(['doctor'], {}, preload)
    await until(async () => {
      const trace = await readFile(f.trace, 'utf8')
      return trace.includes('never-ready-child-created')
    }, 'never-ready child creation')
    const started = Date.now()
    run.child.kill('SIGINT')
    const result = await run.done
    assert.equal(result.code, 130, result.output)
    assert.ok(Date.now() - started < 11500, result.output)
    assert.match(result.output, /did not exit after SIGKILL/)
    assert.doesNotMatch(result.output, /UnhandledPromiseRejection/)
    const trace = await readFile(f.trace, 'utf8')
    assert.match(trace, /pending-child-SIGTERM/)
    assert.match(trace, /pending-child-SIGKILL/)
    assert.match(trace, /pending-handle-released/)
    assert.doesNotMatch(trace, /doctor-entered/)
  })

  test('TERM resistant owned group escalates to KILL and reaps within final bound', async () => {
    const child = { pid: 48123, exitCode: null, signalCode: null } as ChildProcess
    const signals: NodeJS.Signals[] = []
    let waits = 0
    const error = await stopServer(child, false, {
      signal: (_pid, signal) => {
        signals.push(signal as NodeJS.Signals)
        return true
      },
      wait: async (_pid, timeout) => {
        assert.equal(timeout, 5000)
        waits++
        return waits > 1
      },
      close: async () => undefined,
    }).then(
      () => undefined,
      (failure: unknown) => failure
    )
    assert.deepEqual(signals, ['SIGTERM', 'SIGKILL'])
    assert.equal(waits, 2)
    assert.equal(error, undefined)
  })

  test('failed final reap remains an explicit cleanup failure', async () => {
    const child = { pid: 48124, exitCode: null, signalCode: null } as ChildProcess
    const signals: NodeJS.Signals[] = []
    const error = await stopServer(child, false, {
      signal: (_pid, signal) => {
        signals.push(signal as NodeJS.Signals)
        return true
      },
      wait: async (_pid, timeout) => {
        assert.equal(timeout, 5000)
        return false
      },
      close: async () => undefined,
    }).then(
      () => undefined,
      (failure: unknown) => failure
    )
    assert.deepEqual(signals, ['SIGTERM', 'SIGKILL'])
    assert.ok(error instanceof AggregateError)
    assert.match(error.message, /failed to clean up owned recording process group/)
    assert.match(String(error.errors[0]), /did not exit after SIGKILL/)
  })

  test('falsy caught failures remain errors', () => {
    for (const failure of [null, undefined, false, 0, ''])
      assert.ok(recordingFailure(failure, [], true) instanceof Error)
  })

  test('primary startup error and cleanup error remain separately inspectable', () => {
    const startup = new Error('server did not start')
    const cleanup = new AggregateError(
      [new Error('final reap failed')],
      'owned group cleanup failed'
    )
    const failure = recordingFailure(startup, [cleanup])
    assert.ok(failure instanceof AggregateError)
    assert.equal(failure.message, 'recording failed and cleanup also failed')
    assert.equal(failure.errors[0], startup)
    assert.equal(failure.errors[1], cleanup)
  })
})
