// Records every command the consumer run executes, with secrets redacted, for the evidence file.
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { relative } from 'node:path'
import { repoRoot, secret } from './settings.mjs'

export const output = []
export const commands = []

export function redact(value) {
  return secret ? String(value).split(secret).join('[REDACTED]') : String(value)
}

export function run(command, args, cwd, env = process.env) {
  const record = { command, args, cwd: relative(repoRoot, cwd) || '.', exitCode: null }
  commands.push(record)
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  })
  record.exitCode = result.status ?? 1
  const text = [result.stdout, result.stderr].filter(Boolean).join('')
  if (text) output.push({ command: `${command} ${args.join(' ')}`, text: redact(text) })
  if (result.error || result.status !== 0) {
    const detail = result.error?.message ?? text.slice(-6000) ?? 'command failed'
    throw new Error(`${command} ${args.join(' ')} failed (${record.exitCode}): ${redact(detail)}`)
  }
  return result.stdout
}

export function expectFailure(command, args, cwd, env, expected) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  })
  const outputText = [result.stdout, result.stderr].filter(Boolean).join('')
  commands.push({
    command,
    args,
    cwd: relative(repoRoot, cwd) || '.',
    exitCode: result.status ?? 1,
  })
  if (result.error || result.status === 0 || !outputText.includes(expected)) {
    throw new Error(`Expected ${command} ${args.join(' ')} to reject: ${expected}`)
  }
  output.push({
    command: `${command} ${args.join(' ')} (expected rejection)`,
    text: redact(outputText),
  })
}

export async function digest(path) {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex')
}

export async function hashFiles(paths) {
  const entries = []
  for (const path of paths) entries.push([path, await digest(path)])
  return entries
}
