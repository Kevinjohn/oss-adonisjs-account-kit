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

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    test(`${signal} returns its status and terminates the ready owned step group`, async (t) => {
      const root = await mkdtemp(join(tmpdir(), 'check-changed-signal-'))
      t.cleanup(() => rm(root, { recursive: true, force: true }))
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
const descendant = spawn(process.execPath, ['-e', 'console.log("ready"); setInterval(() => {}, 1000)'], { stdio: ['ignore', 'pipe', 'inherit'] })
descendant.stdout.once('data', () => fs.writeFileSync(process.env.READY, JSON.stringify([process.pid, descendant.pid])))
setInterval(() => {}, 1000)
`
      )
      for (const name of ['git', 'pnpm']) await chmod(join(root, 'bin', name), 0o755)
      const ready = join(root, 'ready')
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
      let pids: number[] = []
      t.cleanup(async () => {
        child.kill('SIGKILL')
        for (const pid of pids) {
          try {
            process.kill(pid, 'SIGKILL')
          } catch {}
        }
        await done
      })
      await until(async () => {
        assert.equal(child.exitCode, null, output)
        try {
          pids = JSON.parse(await readFile(ready, 'utf8'))
          return pids.length === 2
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
          throw error
        }
      }, 'active step and descendant readiness')
      child.kill(signal)
      const code = await done
      assert.equal(code, signal === 'SIGINT' ? 130 : 143, output)
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
