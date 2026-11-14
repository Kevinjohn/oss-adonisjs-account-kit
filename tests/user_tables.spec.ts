import { readFile } from 'node:fs/promises'
import { test } from '@japa/runner'
import { migrationNames, migrationSchema } from '../configure.js'
import { userOwnedRows } from '../src/user_rows.js'
import { userTables } from './helpers/test_rows.js'

/**
 * User-keyed tables `deleteUserRows` handles outside `userOwnedRows`: sign-in rows only when
 * authentication is configured, and sent invitations by the `accountDeletion.invitations` policy.
 */
const handledSeparately = [
  ['account_sessions', 'user_id'],
  ['account_invitations', 'inviter_id'],
]

/** Every `table.column` that the migrations `configure` installs key by a user id. */
async function migratedUserColumns(): Promise<string[]> {
  const schema = migrationSchema() as Record<string, string>
  const found: string[] = []
  for (const name of migrationNames) {
    const stub = await readFile(
      new URL(`../stubs/migrations/${name}.stub`, import.meta.url),
      'utf8'
    )
    const table = stub.match(/protected tableName = '(\w+)'/)?.[1]
    const references = stub.matchAll(
      /\{\{\{ migration\.(\w+) \}\}\}[^\n]*\.inTable\(\{\{\{ migration\.usersTable \}\}\}\)/g
    )
    for (const [, placeholder] of references) {
      const column = schema[placeholder]?.match(/'(\w+)'/)?.[1]
      if (!table || !column) throw new Error(`Cannot read the user column in ${name}.stub`)
      found.push(`${table}.${column}`)
    }
  }
  return found
}

test.group('user-keyed table lists', () => {
  test('deletion and test cleanup lists cover every user column the migrations create', async ({
    assert,
  }) => {
    const migrated = await migratedUserColumns()
    assert.includeMembers(migrated, [
      'password_reset_tokens.tokenable_id',
      'social_identities.user_id',
    ])
    const source = [
      ...userOwnedRows.map(({ table, column }) => `${table}.${column}`),
      ...handledSeparately.map(([table, column]) => `${table}.${column}`),
    ]
    const cleanup = userTables.map(([table, column]) => `${table}.${column}`)
    assert.includeMembers(source, migrated, 'src/user_rows.ts misses a user-keyed table')
    assert.includeMembers(cleanup, migrated, 'tests/helpers/test_rows.ts misses a user-keyed table')
  })
})
