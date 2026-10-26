import { test } from '@japa/runner'
import type { Database } from '@adonisjs/lucid/database'
import { isUserEmailUniqueViolation } from '../src/unique_violation.js'
import type { UsersStorage } from '../src/user_lock.js'

/** A database whose only job is to answer the index-lookup query with the given rows. */
function fakeDb(rows: Array<{ name: string }>, calls: unknown[][] = []) {
  return {
    rawQuery: async (sql: string, bindings: unknown[]) => {
      calls.push([sql, bindings])
      // pg wraps rows in a result object; mysql2 returns `[rows, fields]`.
      return sql.includes('pg_index') ? { rows } : [rows, []]
    },
  } as unknown as Database
}

function storage(emailConstraint?: string): UsersStorage {
  return { users: {}, usersTable: 'users', emailConstraint } as unknown as UsersStorage
}

test.group('user email unique-violation identity per driver', () => {
  test('ignores non-object values and non-unique error codes', async ({ assert }) => {
    const db = fakeDb([])
    assert.isFalse(await isUserEmailUniqueViolation(null, storage(), db))
    assert.isFalse(await isUserEmailUniqueViolation('23505', storage(), db))
    assert.isFalse(await isUserEmailUniqueViolation({ code: '23503' }, storage(), db))
  })

  test('PostgreSQL: an explicit constraint name is compared without querying the catalog', async ({
    assert,
  }) => {
    const calls: unknown[][] = []
    const db = fakeDb([{ name: 'users_email_unique' }], calls)
    const error = { code: '23505', constraint: 'users_email_key' }
    assert.isTrue(await isUserEmailUniqueViolation(error, storage('users_email_key'), db))
    assert.isFalse(await isUserEmailUniqueViolation(error, storage('other_key'), db))
    assert.lengthOf(calls, 0)
  })

  test('PostgreSQL: without an explicit name, only a single-column unique email index matches', async ({
    assert,
  }) => {
    const calls: unknown[][] = []
    const db = fakeDb([{ name: 'users_email_key' }], calls)
    assert.isTrue(
      await isUserEmailUniqueViolation(
        { code: '23505', constraint: 'users_email_key' },
        storage(),
        db
      )
    )
    assert.isFalse(
      await isUserEmailUniqueViolation(
        { code: '23505', constraint: 'users_alias_key' },
        storage(),
        db
      )
    )
    assert.lengthOf(calls, 2)
    assert.deepEqual(calls[0][1], ['users'])
    assert.match(String(calls[0][0]), /indisunique and i\.indnkeyatts = 1/)
  })

  test('SQLite: falls back to the message-based check', async ({ assert }) => {
    const db = fakeDb([])
    const violation = (column: string) => ({
      code: 'SQLITE_CONSTRAINT_UNIQUE',
      message: `UNIQUE constraint failed: users.${column}`,
    })
    assert.isTrue(await isUserEmailUniqueViolation(violation('email'), storage(), db))
    assert.isFalse(await isUserEmailUniqueViolation(violation('alias'), storage(), db))
  })

  test('MySQL: the key must name the users table and its unique email index', async ({
    assert,
  }) => {
    const duplicate = (key: string) => ({
      code: 'ER_DUP_ENTRY',
      sqlMessage: `Duplicate entry 'person@example.test' for key '${key}'`,
    })
    const calls: unknown[][] = []
    const db = fakeDb([{ name: 'users_email_unique' }], calls)
    assert.isFalse(
      await isUserEmailUniqueViolation(duplicate('accounts.users_email_unique'), storage(), db),
      'another table is never the users email index'
    )
    assert.lengthOf(calls, 0)
    assert.isTrue(
      await isUserEmailUniqueViolation(duplicate('users.email_key'), storage('email_key'), db)
    )
    assert.isFalse(
      await isUserEmailUniqueViolation(duplicate('users.other_key'), storage('email_key'), db)
    )
    assert.lengthOf(calls, 0, 'an explicit index name skips information_schema')
    assert.isTrue(
      await isUserEmailUniqueViolation(duplicate('users.users_email_unique'), storage(), db)
    )
    assert.isFalse(await isUserEmailUniqueViolation(duplicate('users.users_alias'), storage(), db))
    assert.lengthOf(calls, 2)
    assert.match(String(calls[0][0]), /information_schema\.statistics/)
    assert.deepEqual(calls[0][1], ['users'])
  })
})
