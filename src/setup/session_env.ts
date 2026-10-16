import { createReadStream } from 'node:fs'
import { lstat } from 'node:fs/promises'
import { relative } from 'node:path'
import { createInterface } from 'node:readline'
import { parseEnv } from 'node:util'
import { EnvLoader } from '@adonisjs/core/env'
import { safeSetupPath } from './safe_path.js'

/** Resolve one selected enum without loading an application's other environment values. */
export async function selectedSessionEnvironment(
  root: string,
  variable: string
): Promise<string | null> {
  if (Object.hasOwn(process.env, variable)) return process.env[variable] ?? null
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
    try {
      for await (const line of lines) {
        if (!new RegExp(`^\\s*(?:export\\s+)?${variable}\\b`).test(line)) continue
        if (found || !new RegExp(`^\\s*(?:export\\s+)?${variable}\\s*=`).test(line))
          throw new Error('Selected session environment assignment is ambiguous')
        found = true
        if (line.includes('$') || line.includes('`'))
          throw new Error('Selected session environment assignment must be a direct value')
        try {
          value = parseEnv(line)[variable] ?? null
        } catch {
          throw new Error('Selected session environment assignment is malformed')
        }
        if (!value || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value))
          throw new Error('Selected session environment value must be a direct store name')
      }
    } finally {
      lines.close()
      stream.destroy()
    }
    if (found) return value
  }
  return null
}
