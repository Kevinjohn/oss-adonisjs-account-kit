import { test } from '@japa/runner'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile, chmod, readdir, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
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
  await writeFile(join(app, 'ace'), '// synthetic Ace entrypoint\n')
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
  await writeFile(
    join(app, '.account-kit-demo.json'),
    JSON.stringify({ version: 1, role: 'feature-recording', root: await realpath(app) })
  )
  await writeFile(
    join(bin, 'node'),
    `#!/bin/sh
if [ "$2" = "migration:fresh" ]; then echo migration >> "$TRACE"; exit 0; fi
if [ "$2" = "account-kit:doctor" ]; then echo healthy; exit 0; fi
if [ "$2" = "serve" ]; then
  echo server-spawned >> "$TRACE"
  if [ "${'${FAIL_START:-}'}" = "1" ]; then echo startup-failure; exit 9; fi
  if [ "${'${HOLD_START:-}'}" = "1" ]; then echo booting; trap 'echo cleaned >> "$TRACE"; exit 0' TERM; while :; do sleep 1; done; fi
  echo 'started HTTP server'
  echo server-ready >> "$TRACE"
  if [ "${'${IGNORE_TERM:-}'}" = "1" ]; then trap '' TERM; sleep 60 & echo $! > "$TRACE.descendant"; wait $!; while :; do sleep 60; done; else trap 'echo cleaned >> "$TRACE"; exit 0' TERM; fi
  while :; do sleep 1; done
fi
exit 0
`
  )
  await writeFile(join(bin, 'curl'), '#!/bin/sh\nprintf "\\n200"\n')
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
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    TRACE: join(root, 'trace'),
    LSOF_CALLS: join(root, 'lsof-calls'),
  }
  const start = (args: string[], extra: NodeJS.ProcessEnv = {}) => {
    const child = spawn(
      process.execPath,
      ['--import=@poppinss/ts-exec', recorder, app, output, ...args],
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

  test('SIGINT during recording returns 130 and does not save or start more scenarios', async (t) => {
    const f = await fixture()
    t.cleanup(f.cleanup)
    const run = f.start(['signup-verification'])
    await until(async () => {
      const trace = await readFile(f.trace, 'utf8')
      return trace.includes('server-ready')
    }, 'server readiness')
    run.child.kill('SIGINT')
    const result = await run.done
    assert.equal(result.code, 130, result.output)
    const trace = await readFile(f.trace, 'utf8')
    assert.equal(trace.includes('cleaned'), true)
    assert.deepEqual(await readdir(f.output), [])
  })

  test('second signal forces owned group escalation without replacing first exit result', async (t) => {
    const f = await fixture()
    t.cleanup(f.cleanup)
    const run = f.start(['doctor'], { IGNORE_TERM: '1' })
    await until(async () => {
      const trace = await readFile(f.trace, 'utf8')
      return trace.includes('server-ready')
    }, 'server readiness')
    run.child.kill('SIGINT')
    setTimeout(() => run.child.kill('SIGTERM'), 20)
    const result = await run.done
    assert.equal(result.code, 130, result.output)
  })

  test('TERM resistant descendant is killed and the process group is reaped', async (t) => {
    const f = await fixture()
    t.cleanup(f.cleanup)
    const result = await f.start(['doctor'], { IGNORE_TERM: '1' }).done
    assert.equal(result.code, 0, result.output)
    const descendant = Number(await readFile(`${f.trace}.descendant`, 'utf8'))
    assert.throws(() => process.kill(descendant, 0), { code: 'ESRCH' })
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
    assert.match(error.message, /failed to clean up owned server process group/)
    assert.match(String(error.errors[0]), /did not exit after SIGKILL/)
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
