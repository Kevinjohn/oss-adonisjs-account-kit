import { RuntimeException } from '@adonisjs/core/exceptions'
import {
  E_ACCOUNT_KIT_INDIRECT_ENVIRONMENT_VALUE,
  E_ACCOUNT_KIT_SELECTED_ENVIRONMENT_VALUE,
} from '../errors.js'
import { createReadStream } from 'node:fs'
import { lstat } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { parseEnv } from 'node:util'
import { envName } from './diagnostics.js'
import { requireSafeSetupPath } from './safe_path.js'

/** Node's `parseEnv` treats no character as an escape: the next matching quote closes the value. */
function hasClosingQuote(text: string, quote: string): boolean {
  return text.includes(quote)
}

/** Match AdonisJS EnvLoader precedence without changing global process.env to select a profile. */
function listDotenvPaths(root: string, env: NodeJS.ProcessEnv): string[] {
  const base = resolve(root, env.ENV_PATH || '')
  const mode = env.NODE_ENV
  return [
    ...(mode ? [join(base, `.env.${mode}.local`)] : []),
    ...(!mode || !['test', 'testing'].includes(mode) ? [join(base, '.env.local')] : []),
    ...(mode ? [join(base, `.env.${mode}`)] : []),
    join(base, '.env'),
  ]
}

async function resolveEnvironmentValue(
  root: string,
  variable: string,
  env: NodeJS.ProcessEnv,
  validate: (value: string | null) => boolean,
  expected: string
): Promise<string | null> {
  if (!envName.test(variable) || variable.trim() !== variable) return null
  const escapedVariable = variable.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const assignmentStart = new RegExp(`^\\s*(?:export\\s+)?${escapedVariable}\\b`)
  const assignmentValue = new RegExp(`^\\s*(?:export\\s+)?${escapedVariable}\\s*=`)
  if (Object.hasOwn(env, variable)) return env[variable] ?? null
  for (const candidate of listDotenvPaths(root, env)) {
    const name = relative(root, candidate)
    const path = await requireSafeSetupPath(root, name)
    let stat
    try {
      stat = await lstat(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    if (!stat.isFile())
      throw new RuntimeException('Selected environment file must be a regular file')
    const stream = createReadStream(path)
    const lines = createInterface({ input: stream, crlfDelay: Infinity })
    let value: string | null = null
    let found = false
    let multilineQuote: '"' | "'" | '`' | null = null
    try {
      for await (const line of lines) {
        if (multilineQuote) {
          if (assignmentStart.test(line))
            throw new E_ACCOUNT_KIT_SELECTED_ENVIRONMENT_VALUE(
              'Selected environment assignment is inside a multiline value'
            )
          if (hasClosingQuote(line, multilineQuote)) multilineQuote = null
          continue
        }
        const quotedAssignment = /^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*(['"`])/.exec(line)
        if (quotedAssignment) {
          const rest = line.slice(quotedAssignment[0].length)
          if (!hasClosingQuote(rest, quotedAssignment[1]))
            multilineQuote = quotedAssignment[1] as '"' | "'" | '`'
        }
        if (!assignmentStart.test(line)) continue
        if (found || !assignmentValue.test(line))
          throw new E_ACCOUNT_KIT_SELECTED_ENVIRONMENT_VALUE(
            'Selected environment assignment is ambiguous'
          )
        found = true
        if (line.includes('$') || line.includes('`'))
          throw new E_ACCOUNT_KIT_INDIRECT_ENVIRONMENT_VALUE()
        try {
          value = parseEnv(line)[variable] ?? null
        } catch {
          throw new E_ACCOUNT_KIT_SELECTED_ENVIRONMENT_VALUE(
            'Selected environment assignment is malformed'
          )
        }
        if (!validate(value))
          throw new E_ACCOUNT_KIT_SELECTED_ENVIRONMENT_VALUE(
            `Selected environment value must be ${expected}`
          )
      }
    } finally {
      lines.close()
      stream.destroy()
    }
    if (found) return value
  }
  return null
}

/** Resolve one selected enum without loading an application's other environment values. */
export function resolveSelectedEnvironment(
  root: string,
  variable: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<string | null> {
  return resolveEnvironmentValue(
    root,
    variable,
    env,
    (value) => Boolean(value && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value)),
    'a direct name'
  )
}

/** Resolve one selected scalar without loading an application's other environment values. */
export function resolveSelectedEnvironmentValue(
  root: string,
  variable: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<string | null> {
  return resolveEnvironmentValue(root, variable, env, (value) => value !== null, 'a direct value')
}
