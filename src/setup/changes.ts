import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { migrationSchema } from '../../configure.js'
import type { SetupChoices, SetupFileChange, SetupInspection } from './types.js'
import { hasEmailFlow } from './shared.js'

export function generatedEnv(choices: SetupChoices): string {
  const names = new Set<string>()
  if (hasEmailFlow(choices)) {
    names.add(choices.mail.backendOriginEnv)
    names.add(choices.mail.frontendOriginEnv)
    if (choices.mail.senderEnv) names.add(choices.mail.senderEnv)
    if (choices.mail.transportEnv) names.add(choices.mail.transportEnv)
  }
  if (choices.social.status === 'enabled') {
    names.add(choices.social.callbackOriginEnv)
    for (const provider of choices.social.providers) {
      const refs = choices.social.credentials[provider]
      if (refs) {
        names.add(refs.clientIdEnv)
        names.add(refs.clientSecretEnv)
      }
    }
  }
  return [
    '# Account Kit deployment values; supply real values through your deployment environment',
    ...[...names].sort().map((name) => `${name}=`),
    '',
  ].join('\n')
}

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

export function addChange(
  changes: SetupFileChange[],
  state: SetupInspection,
  path: string,
  content: string,
  reason: string
) {
  const existing = state.files[path]
  changes.push({
    path,
    action: existing === undefined ? 'create' : existing === content ? 'unchanged' : 'conflict',
    content,
    reason,
  })
}

export function ownedChange(
  changes: SetupFileChange[],
  state: SetupInspection,
  path: string,
  content: string,
  oldGenerated: string | null,
  reason: string
) {
  const existing = state.files[path]
  changes.push({
    path,
    action:
      existing === undefined
        ? 'create'
        : existing === content
          ? 'unchanged'
          : oldGenerated !== null && existing === oldGenerated
            ? 'update'
            : 'conflict',
    expected: existing,
    content,
    reason,
  })
}

export function changedFields(before: unknown, after: unknown, path = ''): string[] {
  if (JSON.stringify(before) === JSON.stringify(after)) return []
  if (
    !before ||
    !after ||
    typeof before !== 'object' ||
    typeof after !== 'object' ||
    Array.isArray(before) ||
    Array.isArray(after)
  )
    return [path]
  const oldRecord = before as Record<string, unknown>
  const newRecord = after as Record<string, unknown>
  return [...new Set([...Object.keys(oldRecord), ...Object.keys(newRecord)])].flatMap((key) =>
    changedFields(oldRecord[key], newRecord[key], path ? `${path}.${key}` : key)
  )
}
