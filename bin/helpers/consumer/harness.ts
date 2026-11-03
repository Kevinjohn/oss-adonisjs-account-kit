// Records every command the consumer run executes, with secrets redacted, for the evidence file.
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { relative } from 'node:path'
import { repoRoot, secret } from './settings.js'

export const output: { command: string; text: string }[] = []
type CommandRecord = { command: string; args: string[]; cwd: string; exitCode: number | null }
export const commands: CommandRecord[] = []

export function redact(value: unknown) {
  return secret ? String(value).split(secret).join('[REDACTED]') : String(value)
}

export function run(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env
) {
  const record: CommandRecord = {
    command,
    args,
    cwd: relative(repoRoot, cwd) || '.',
    exitCode: null,
  }
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

export function expectFailure(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  expected: string
) {
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

export async function digest(path: string) {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex')
}

export async function hashFiles(paths: string[]) {
  const entries = []
  for (const path of paths) entries.push([path, await digest(path)])
  return entries
}
