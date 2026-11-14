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

/**
 * The `table.column` entries a migration stub keys by a user id: every `{{{ migration.*IdColumn }}}`
 * placeholder, wherever its foreign key is declared, or if it has none.
 */
function userColumnsIn(name: string, stub: string): string[] {
  const schema = migrationSchema() as Record<string, string>
  const table = stub.match(/protected tableName = '(\w+)'/)?.[1]
  const placeholders = [...stub.matchAll(/\{\{\{ migration\.(\w+IdColumn) \}\}\}/g)]
  const references = [...stub.matchAll(/\.inTable\(\{\{\{ migration\.usersTable \}\}\}\)/g)]
  // A users-table reference without a placeholder is a user column with a hard-coded type.
  if (references.length > placeholders.length)
    throw new Error(`${name}.stub references the users table without a user id placeholder`)
  return placeholders.map(([, placeholder]) => {
    const column = schema[placeholder]?.match(/'(\w+)'/)?.[1]
    if (!table || !column) throw new Error(`Cannot read the user column in ${name}.stub`)
    return `${table}.${column}`
  })
}

/** Every `table.column` that the migrations `configure` installs key by a user id. */
async function migratedUserColumns(): Promise<string[]> {
  const found: string[] = []
  for (const name of migrationNames) {
    const stub = await readFile(
      new URL(`../stubs/migrations/${name}.stub`, import.meta.url),
      'utf8'
    )
    found.push(...userColumnsIn(name, stub))
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

  test('collects a user column whatever shape its foreign key takes', ({ assert }) => {
    const stub = [
      "  protected tableName = 'audit_entries'",
      '      {{{ migration.userIdColumn }}}.notNullable()',
      "      table.foreign('user_id').references('id').inTable({{{ migration.usersTable }}})",
      '      {{{ migration.actorIdColumn }}}.nullable().index()',
    ].join('\n')
    assert.deepEqual(userColumnsIn('audit', stub), [
      'audit_entries.user_id',
      'audit_entries.approval_actor_id',
    ])
    assert.throws(
      () =>
        userColumnsIn(
          'typed',
          [
            "  protected tableName = 'typed_rows'",
            "      table.integer('owner_id').references('id').inTable({{{ migration.usersTable }}})",
          ].join('\n')
        ),
      /without a user id placeholder/
    )
  })
})
