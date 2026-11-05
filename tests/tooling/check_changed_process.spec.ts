import { test } from '@japa/runner'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repository = fileURLToPath(new URL('../../', import.meta.url))

async function until(check: () => Promise<boolean>, description: string) {
  const deadline = Date.now() + 5000
  while (!(await check())) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${description}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

async function terminated(pid: number) {
  try {
    process.kill(pid, 0)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true
    throw error
  }
  if (process.platform !== 'linux') return false
  // A killed orphan may remain a zombie until the host reaps it.
  try {
    return /\) Z /.test(await readFile(`/proc/${pid}/stat`, 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

test.group('check:changed process signals', (group) => {
  group.each.timeout(20_000)

  for (const scenario of ['SIGINT', 'SIGTERM', 'startup failure'] as const) {
    test(`${scenario} terminates its owned step group`, async (t) => {
      const root = await mkdtemp(join(tmpdir(), 'check-changed-signal-'))
      let cleanupProcesses: (() => Promise<void>) | undefined
      t.cleanup(async () => {
        try {
          await cleanupProcesses?.()
        } finally {
          await rm(root, { recursive: true, force: true })
        }
      })
      await mkdir(join(root, 'bin'))
      await writeFile(join(root, 'package.json'), '{"type":"module"}')
      await symlink(join(repository, 'node_modules'), join(root, 'node_modules'), 'dir')
      for (const name of ['check_changed.ts', 'check_changed_plan.ts'])
        await copyFile(join(repository, 'bin', name), join(root, 'bin', name))
      await writeFile(
        join(root, 'bin/git'),
        `#!${process.execPath}
const args = process.argv.slice(2)
if (args[0] === 'rev-parse' || args[0] === 'merge-base') console.log('0123456789abcdef')
if (args[0] === 'diff') process.stdout.write('M\\0src/example.ts\\0')
`
      )
      await writeFile(
        join(root, 'bin/pnpm'),
        `#!${process.execPath}
import fs from 'node:fs'
import { spawn } from 'node:child_process'
fs.appendFileSync(process.env.TRACE, JSON.stringify(process.argv.slice(2)) + '\\n')
const publish = (path, pids) => {
  fs.writeFileSync(path + '.pending', JSON.stringify(pids))
  fs.renameSync(path + '.pending', path)
}
publish(process.env.OWNED, [process.pid])
const descendant = spawn(process.execPath, ['-e', 'if (!process.env.HOLD_READY) console.log("ready"); setInterval(() => {}, 1000)'], { stdio: ['ignore', 'pipe', 'inherit'] })
publish(process.env.OWNED, [process.pid, descendant.pid])
descendant.stdout.once('data', () => publish(process.env.READY, [process.pid, descendant.pid]))
setInterval(() => {}, 1000)
`
      )
      for (const name of ['git', 'pnpm']) await chmod(join(root, 'bin', name), 0o755)
      const ready = join(root, 'ready')
      const owned = join(root, 'owned')
      const trace = join(root, 'trace')
      const child = spawn(
        process.execPath,
        ['--import=@poppinss/ts-exec', join(root, 'bin/check_changed.ts'), '--static', 'main'],
        {
          cwd: root,
          env: {
            ...process.env,
            PATH: `${join(root, 'bin')}:${process.env.PATH}`,
            READY: ready,
            OWNED: owned,
            HOLD_READY: scenario === 'startup failure' ? '1' : '',
            TRACE: trace,
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        }
      )
      let output = ''
      child.stdout.on('data', (chunk) => (output += chunk))
      child.stderr.on('data', (chunk) => (output += chunk))
      const done = new Promise<number | null>((resolve, reject) => {
        child.once('close', resolve)
        child.once('error', reject)
      })
      const readOwned = async (): Promise<number[]> => {
        try {
          return JSON.parse(await readFile(owned, 'utf8'))
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
          throw error
        }
      }
      const killOwned = async () => {
        const pids = await readOwned()
        if (pids.length) {
          try {
            process.kill(-pids[0], 'SIGKILL')
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
          }
        }
      }
      const cleanupOwned = async () => {
        child.kill('SIGTERM')
        let timer: NodeJS.Timeout | undefined
        try {
          const closed = await Promise.race([
            done.then(() => true),
            new Promise<false>((resolve) => {
              timer = setTimeout(() => resolve(false), 1000)
            }),
          ])
          if (!closed) {
            await killOwned()
            child.kill('SIGKILL')
          }
          await done
          await killOwned()
          const pids = await readOwned()
          await until(async () => {
            const stopped = await Promise.all(pids.map(terminated))
            return stopped.every(Boolean)
          }, 'failure cleanup of owned group')
        } finally {
          clearTimeout(timer)
        }
      }
      let cleanupResult: Promise<void> | undefined
      const cleanup = () => (cleanupResult ??= cleanupOwned())
      cleanupProcesses = cleanup
      let pids: number[] = []
      await until(async () => {
        assert.equal(child.exitCode, null, output)
        pids = await readOwned()
        return pids.length === 2
      }, 'independent owned group record')
      if (scenario === 'startup failure') {
        // Deliberately fail before readiness, then exercise the same registered teardown.
        const failure = new Error('startup interrupted before descendant readiness')
        await assert.rejects(
          async () => {
            try {
              await assert.rejects(readFile(ready), { code: 'ENOENT' })
              throw failure
            } finally {
              await cleanup()
            }
          },
          (error) => error === failure
        )
        assert.equal(child.exitCode, 143, output)
        for (const pid of pids) assert.equal(await terminated(pid), true)
        return
      }
      await until(async () => {
        assert.equal(child.exitCode, null, output)
        try {
          const readyPids = JSON.parse(await readFile(ready, 'utf8'))
          assert.deepEqual(readyPids, pids)
          return true
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
          throw error
        }
      }, 'active step and descendant readiness')
      child.kill(scenario)
      const code = await done
      assert.equal(code, scenario === 'SIGINT' ? 130 : 143, output)
      await until(async () => {
        const stopped = await Promise.all(pids.map(terminated))
        return stopped.every(Boolean)
      }, 'owned group termination')
      const traceText = await readFile(trace, 'utf8')
      const commands = traceText
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
      assert.equal(commands.length, 1, 'no later selected step should start')
      assert.deepEqual(commands[0].slice(0, 3), ['exec', 'prettier', '--check'])
      assert.doesNotMatch(output, /format: pass|lint: pass|typecheck: pass/)
    })
  }
})
