import { test } from '@japa/runner'
import { createSqlUsersAdapter } from '../src/adapters/sql.ts'
import { createDeferredSqlUsersAdapter } from '../src/deferred_sql_adapter.ts'

test.group('Deferred SQL users adapter', () => {
  test('forwards every method the SQL users adapter exposes', ({ assert }) => {
    const deferred = createDeferredSqlUsersAdapter(() => 'users', {})
    const sql = createSqlUsersAdapter({ table: 'users' })
    assert.sameMembers(Object.keys(deferred), Object.keys(sql))
  })
})
