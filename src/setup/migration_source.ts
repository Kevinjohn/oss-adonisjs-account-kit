import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { migrationSchema } from '../../configure.js'
import type { SetupChoices } from './types.js'

export async function migrationContent(name: string, choices: SetupChoices): Promise<string> {
  let directory = dirname(fileURLToPath(import.meta.url))
  let stub: string | undefined
  for (let depth = 0; depth < 3; depth++) {
    try {
      stub = await readFile(join(directory, 'stubs/migrations', `${name}.stub`), 'utf8')
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    directory = dirname(directory)
  }
  if (stub === undefined) throw new Error(`Account Kit migration template ${name} is missing`)
  const schema = migrationSchema(choices.user.table, choices.user.idType)
  return stub
    .replace(/^\{\{\{ exports\([^\n]+\n\n/, '')
    .replaceAll('{{{ migration.usersTable }}}', schema.usersTable)
    .replaceAll('{{{ migration.userIdColumn }}}', schema.userIdColumn)
    .replaceAll('{{{ migration.tokenableIdColumn }}}', schema.tokenableIdColumn)
    .replaceAll('{{{ migration.inviterIdColumn }}}', schema.inviterIdColumn)
}
