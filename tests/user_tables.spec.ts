import { readFile } from 'node:fs/promises'
import { test } from '@japa/runner'
import { migrationNames, migrationSchema } from '../configure.js'
import { exportedUserColumns, omittedUserColumns } from '../src/account_export_coverage.js'
import { admissionTable } from '../src/admission/rows.js'
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
 * The optional admission module's user columns, which the core export cannot name without importing
 * that module. The application exports the admission record through `exportAccountData`.
 */
const admissionOmissions = [
  {
    column: `${admissionTable}.user_id`,
    reason:
      'Optional admission module: the application adds the record through `exportAccountData`.',
  },
  {
    column: `${admissionTable}.approval_actor_id`,
    reason: "The deciding owner's id on another user's admission record; set to null on deletion.",
  },
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

/** Every `table.column` that the given migration stubs (by default, those `configure` installs) key by a user id. */
async function migratedUserColumns(names: readonly string[] = migrationNames): Promise<string[]> {
  const found: string[] = []
  for (const name of names) {
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

  test('the account export reads or deliberately omits every user column the migrations create', async ({
    assert,
  }) => {
    // `account-kit:admission:install` adds the admission migration on top of the configure set.
    const migrated = await migratedUserColumns([...migrationNames, 'create_account_admissions'])
    assert.include(migrated, 'account_admissions.approval_actor_id')
    const omitted = [...omittedUserColumns, ...admissionOmissions]
    const classified = [...exportedUserColumns, ...omitted.map(({ column }) => column)]
    assert.includeMembers(
      classified,
      migrated,
      'src/account_export_coverage.ts must list every migrated user column as exported or omitted with a reason'
    )
    for (const { column, reason } of omitted) {
      assert.notInclude(exportedUserColumns, column, `${column} is both exported and omitted`)
      assert.isNotEmpty(reason, `${column} needs a reason`)
    }
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
