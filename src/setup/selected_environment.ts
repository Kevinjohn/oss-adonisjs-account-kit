import { createReadStream } from 'node:fs'
import { lstat } from 'node:fs/promises'
import { relative } from 'node:path'
import { createInterface } from 'node:readline'
import { parseEnv } from 'node:util'
import { EnvLoader } from '@adonisjs/core/env'
import type * as TypeScript from 'typescript'
import { safeSetupPath } from './safe_path.js'
import { exactCall, safeEnvGetter, type SetupSource } from './ts_source.js'

function hasClosingQuote(text: string, quote: string): boolean {
  for (let index = 0; index < text.length; index++) {
    if (text[index] === '\\') {
      index++
      continue
    }
    if (text[index] === quote) return true
  }
  return false
}

/** Resolve one selected enum without loading an application's other environment values. */
export async function resolveSelectedEnvironment(
  root: string,
  variable: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<string | null> {
  if (Object.hasOwn(env, variable)) return env[variable] ?? null
  for (const candidate of new EnvLoader(root).getPaths()) {
    const name = relative(root, candidate)
    const path = await safeSetupPath(root, name)
    let stat
    try {
      stat = await lstat(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    if (!stat.isFile()) throw new Error('Selected environment file must be a regular file')
    const stream = createReadStream(path)
    const lines = createInterface({ input: stream, crlfDelay: Infinity })
    let value: string | null = null
    let found = false
    let multilineQuote: '"' | "'" | null = null
    try {
      for await (const line of lines) {
        if (multilineQuote) {
          if (new RegExp(`^\\s*(?:export\\s+)?${variable}\\b`).test(line))
            throw new Error('Selected environment assignment is inside a multiline value')
          if (hasClosingQuote(line, multilineQuote)) multilineQuote = null
          continue
        }
        const quotedAssignment = /^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*(['"])/.exec(line)
        if (quotedAssignment) {
          const rest = line.slice(quotedAssignment[0].length)
          if (!hasClosingQuote(rest, quotedAssignment[1]))
            multilineQuote = quotedAssignment[1] as '"' | "'"
        }
        if (!new RegExp(`^\\s*(?:export\\s+)?${variable}\\b`).test(line)) continue
        if (found || !new RegExp(`^\\s*(?:export\\s+)?${variable}\\s*=`).test(line))
          throw new Error('Selected environment assignment is ambiguous')
        found = true
        if (line.includes('$') || line.includes('`'))
          throw new Error('Selected environment assignment must be a direct value')
        try {
          value = parseEnv(line)[variable] ?? null
        } catch {
          throw new Error('Selected environment assignment is malformed')
        }
        if (!value || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value))
          throw new Error('Selected environment value must be a direct name')
      }
    } finally {
      lines.close()
      stream.destroy()
    }
    if (found) return value
  }
  return null
}

/**
 * Resolve the name chosen by `env.get('NAME')` or `env.get('NAME', 'fallback')`.
 * Returns `undefined` when the expression is not that call on a safe env binding, and `null`
 * when neither the environment nor the fallback names anything. `variable` pins the allowed
 * name; without it, the name must be an upper-case environment variable.
 */
export async function selectedEnvName(
  source: SetupSource,
  root: string,
  envBinding: string | null,
  expression: TypeScript.Expression,
  variable?: string
): Promise<string | null | undefined> {
  const { ts } = source
  if (
    !envBinding ||
    !exactCall(source, expression, envBinding, 'get') ||
    !safeEnvGetter(source, envBinding)
  )
    return undefined
  const args = expression.arguments
  if (
    args.length < 1 ||
    args.length > 2 ||
    !ts.isStringLiteral(args[0]) ||
    (variable === undefined
      ? !/^[A-Z][A-Z0-9_]*$/.test(args[0].text)
      : args[0].text !== variable) ||
    (args.length === 2 && !ts.isStringLiteral(args[1]))
  )
    return undefined
  return (
    (await resolveSelectedEnvironment(root, args[0].text)) ??
    (args.length === 2 ? (args[1] as TypeScript.StringLiteral).text : null)
  )
}
