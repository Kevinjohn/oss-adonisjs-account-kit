import { test } from '@japa/runner'
import { useTestApp } from './helpers/app.js'
import { locksRows } from './helpers/dialect.js'
import { dbTime } from './helpers/db_time.js'
test.group('test application', (group) => {
  const testApp = useTestApp(group)

  test('boots with a resettable database and transaction support', async ({ assert }) => {
    await testApp.db.table('users').insert({
      email: 'person@example.test',
      password: null,
      created_at: dbTime(testApp),
    })

    const user = await testApp.db.from('users').where('email', 'person@example.test').first()
    assert.equal(user.email, 'person@example.test')
    assert.isNull(user.password)

    await testApp.db.transaction(async (trx) => {
      await trx.from('users').where('id', user.id).forUpdate().first()
    })
  })

  test('starts independent pooled SQLite connections in WAL mode', async ({ assert }) => {
    if (locksRows) return
    const client = testApp.db.connection().getWriteClient().client
    const first = (await client.acquireConnection()) as {
      pragma: (statement: string, options: { simple: true }) => string
    }
    try {
      const second = (await client.acquireConnection()) as typeof first
      try {
        assert.notEqual(first, second)
        assert.equal(first.pragma('journal_mode', { simple: true }), 'wal')
        assert.equal(second.pragma('journal_mode', { simple: true }), 'wal')
      } finally {
        await client.releaseConnection(second)
      }
    } finally {
      await client.releaseConnection(first)
    }
  })
})
