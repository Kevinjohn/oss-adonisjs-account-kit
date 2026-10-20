import { test } from '@japa/runner'
import { isUniqueViolation, mysqlDuplicateKey } from '../src/db.js'
import { useTestApp } from './helpers/app.js'
import { resetSchema } from './helpers/schema.js'

test.group('database helper error recognition', (group) => {
  const kit = useTestApp(group)

  test('recognizes a real duplicate users.email violation on each database', async ({ assert }) => {
    const email = 'duplicate@example.test - UNIQUE constraint failed: users.email_alias'
    await kit.db.table('users').insert({ email, created_at: new Date() })
    let duplicateError: unknown
    try {
      await kit.db.table('users').insert({ email, created_at: new Date() })
      assert.fail('expected the unique index to reject a duplicate email')
    } catch (error) {
      duplicateError = error
    }

    assert.isTrue(isUniqueViolation(duplicateError, 'users', 'email'))
    assert.isFalse(isUniqueViolation(duplicateError, 'users', 'password'))
    assert.isFalse(isUniqueViolation(new Error('unrelated failure'), 'users', 'email'))
    assert.isFalse(
      isUniqueViolation(
        { code: '23505', constraint: 'users_password_unique', message: 'duplicate' },
        'users',
        'email'
      )
    )
    assert.isFalse(
      isUniqueViolation(
        { code: 'SQLITE_CONSTRAINT_UNIQUE', message: 'UNIQUE constraint failed: users.password' },
        'users',
        'email'
      )
    )
  })

  test('does not confuse an email-prefixed unique column with users.email', async ({ assert }) => {
    await kit.db.connection().schema.alterTable('users', (table) => {
      table.string('email_alias').unique()
    })
    group.each.teardown(() => resetSchema(kit))
    await kit.db.table('users').insert({
      email: 'first@example.test',
      email_alias: 'same-alias',
      created_at: new Date(),
    })
    let failure: unknown
    try {
      await kit.db.table('users').insert({
        email: 'second@example.test',
        email_alias: 'same-alias',
        created_at: new Date(),
      })
    } catch (error) {
      failure = error
    }
    assert.isDefined(failure)
    assert.isFalse(isUniqueViolation(failure, 'users', 'email'))
  })

  test('reads the key of a MySQL duplicate-entry error', ({ assert }) => {
    const duplicate = (key: string, value = 'person@example.test') => ({
      code: 'ER_DUP_ENTRY',
      errno: 1062,
      sqlMessage: `Duplicate entry '${value}' for key '${key}'`,
    })
    assert.equal(
      mysqlDuplicateKey(duplicate('users.users_email_unique')),
      'users.users_email_unique'
    )
    assert.equal(
      mysqlDuplicateKey(duplicate('users.users_email_unique', "x' for key 'users.other")),
      'users.users_email_unique'
    )
    assert.isUndefined(mysqlDuplicateKey({ code: '23505', constraint: 'users_email_unique' }))
    assert.isUndefined(mysqlDuplicateKey({ code: 'ER_DUP_ENTRY', sqlMessage: 'Duplicate entry' }))
    assert.isTrue(isUniqueViolation(duplicate('users.users_email_unique'), 'users', 'email'))
    assert.isFalse(isUniqueViolation(duplicate('users.users_email_alias_unique'), 'users', 'email'))
    assert.isFalse(isUniqueViolation(duplicate('accounts.users_email_unique'), 'users', 'email'))
  })

  test('recognizes only the documented PostgreSQL email constraint identity', ({ assert }) => {
    assert.isTrue(
      isUniqueViolation({ code: '23505', constraint: 'users_email_unique' }, 'users', 'email')
    )
    assert.isFalse(
      isUniqueViolation({ code: '23505', constraint: 'users_email_key' }, 'users', 'email')
    )
    assert.isFalse(
      isUniqueViolation({ code: '23505', constraint: 'other_users_email_unique' }, 'users', 'email')
    )
  })
})
