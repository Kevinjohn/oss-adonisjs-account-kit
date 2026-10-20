import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { migrationSchema } from '../../configure.js'
import { stubsRoot } from '../../stubs/main.js'
import type { SetupChoices } from './types.js'

export async function migrationContent(name: string, choices: SetupChoices): Promise<string> {
  let stub: string
  try {
    stub = await readFile(join(stubsRoot, 'migrations', `${name}.stub`), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    throw new Error(`Account Kit migration template ${name} is missing`)
  }
  const schema = migrationSchema(choices.user.table, choices.user.idType)
  return stub
    .replace(/^\{\{\{ exports\([^\n]+\n\n/, '')
    .replaceAll('{{{ migration.usersTable }}}', schema.usersTable)
    .replaceAll('{{{ migration.userIdColumn }}}', schema.userIdColumn)
    .replaceAll('{{{ migration.tokenableIdColumn }}}', schema.tokenableIdColumn)
    .replaceAll('{{{ migration.inviterIdColumn }}}', schema.inviterIdColumn)
}
