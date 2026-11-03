#!/usr/bin/env node
// Run the checks that cover every file changed since the merge base with a base ref.
// Usage: pnpm check:changed [--static] [base]   (default: origin/main, else main)
// --static runs every step except the full Japa suite; changed specs still run on their own.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { countTests, planChecks, stepProblem } from './check_changed_plan.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const usage = (message) => {
  console.error(`${message}\nusage: pnpm check:changed [--static] [base]`)
  process.exit(2)
}
const git = (...args) => {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
  return result.status === 0 ? result.stdout : undefined
}

const isStatic = process.argv.includes('--static')
const args = process.argv.slice(2).filter((arg) => arg !== '--static')
if (args.length > 1 || args[0]?.startsWith('-')) usage('Expected at most one base ref')
if (Number(process.versions.node.split('.')[0]) !== 24) {
  console.error(`Node 24 is required, found ${process.version}: nvm use`)
  process.exit(1)
}
if (!existsSync(join(root, 'node_modules'))) {
  console.error('Dependencies are missing: pnpm install')
  process.exit(1)
}
const base =
  args[0] ?? (git('rev-parse', '--verify', '--quiet', 'origin/main') ? 'origin/main' : 'main')
if (!git('rev-parse', '--verify', '--quiet', `${base}^{commit}`)) usage(`Unknown base ref: ${base}`)
const mergeBase = git('merge-base', base, 'HEAD')?.trim()
if (!mergeBase) usage(`No merge base between ${base} and HEAD`)

const files = new Map()
const changed = git('diff', '--name-status', '--no-renames', '-z', mergeBase)?.split('\0') ?? []
for (let index = 0; index + 1 < changed.length; index += 2)
  files.set(changed[index + 1], { path: changed[index + 1], deleted: changed[index] === 'D' })
for (const path of git('ls-files', '-z', '--others', '--exclude-standard')?.split('\0') ?? [])
  if (path) files.set(path, { path, deleted: false })
const list = [...files.values()].sort((a, b) => a.path.localeCompare(b.path))
console.log(`check:changed: ${list.length} files changed since ${base} (${mergeBase.slice(0, 8)})`)

let active
const stop = (pid) => {
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {}
}
// Steps run in their own process group, which a terminal's Ctrl-C does not reach.
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    if (active) stop(active)
    process.exit(130)
  })

/** Run a command in its own process group, killing the group when it outlives its limit. */
function run(command, timeoutMs) {
  return new Promise((done) => {
    const child = spawn(command[0], command.slice(1), {
      cwd: root,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    active = child.pid
    let output = ''
    child.stdout.on('data', (chunk) => (output += chunk))
    child.stderr.on('data', (chunk) => (output += chunk))
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      stop(child.pid)
    }, timeoutMs)
    child.on('close', (code) => {
      clearTimeout(timer)
      active = undefined
      done({ code, output, timedOut })
    })
  })
}

let failed = false
for (const step of planChecks(list, { static: isStatic })) {
  if ('skip' in step) {
    console.log(`${step.id}: skip (${step.skip})`)
    continue
  }
  const before = step.id === 'docs' ? git('status', '--porcelain') : undefined
  const result = await run(step.command, step.timeoutMs)
  const count = step.tests ? countTests(step.tests, result.output) : undefined
  const problem = stepProblem(step, {
    ...result,
    generatedChanged: before !== undefined && git('status', '--porcelain') !== before,
  })
  if (problem) {
    failed = true
    console.log(`${step.id}: fail (${problem})`)
    console.log(result.output.trimEnd().split('\n').slice(-40).join('\n'))
  } else {
    console.log(`${step.id}: pass${count ? ` (${count} tests)` : ''}`)
  }
}
process.exit(failed ? 1 : 0)
