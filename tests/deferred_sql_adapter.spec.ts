import { test } from '@japa/runner'
import { createSqlUsersAdapter } from '../src/adapters/sql.ts'
import { createDeferredSqlUsersAdapter } from '../src/deferred_sql_adapter.ts'

test.group('Deferred SQL users adapter', () => {
  test('forwards every method the SQL users adapter exposes', ({ assert }) => {
    const deferred = createDeferredSqlUsersAdapter(() => 'users', {})
    const sql = createSqlUsersAdapter({ table: 'users' })
    assert.sameMembers(Object.keys(deferred), Object.keys(sql))
  })

  test('resolves the table lazily and reuses it through extracted methods', async ({ assert }) => {
    let resolutions = 0
    const { resolveMetadata } = createDeferredSqlUsersAdapter(() => {
      resolutions++
      return 'members'
    }, {})
    assert.equal(resolutions, 0)
    const first = await resolveMetadata()
    const second = await resolveMetadata()
    assert.equal(first.table, 'members')
    assert.equal(second.table, 'members')
    assert.equal(resolutions, 1)
  })
})
