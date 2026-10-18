import { test } from '@japa/runner'
import { lockRow, transaction } from '../src/db.js'
import type { Database } from '@adonisjs/lucid/database'
import { useTestApp } from './helpers/app.js'
import { locksRows } from './helpers/dialect.js'
import { insertUser } from './helpers/fakes.js'

test.group('package transaction isolation', (group) => {
  const kit = useTestApp(group)

  test('a read after the row lock sees a write committed after the transaction began', async ({
    assert,
  }) => {
    if (!locksRows) return
    const user = await insertUser(kit)
    const email = await transaction(kit.db, async (trx) => {
      // The first read opens a REPEATABLE READ snapshot on MySQL.
      await trx.from('users').where('id', user.id).first()
      await kit.db.from('users').where('id', user.id).update({ email: 'changed@example.test' })
      await lockRow(trx, 'users', user.id)
      const row = await trx.from('users').where('id', user.id).first()
      return row.email
    })
    assert.equal(email, 'changed@example.test')
  })

  test('a MySQL connection must read timestamps back as UTC', async ({ assert }) => {
    const fakeDb = (timezone: string | undefined) =>
      ({
        connection: () => ({
          isTransaction: false,
          connectionName: 'mysql',
          dialect: { name: 'mysql' },
          transaction: async () => {
            throw new Error('transaction began')
          },
        }),
        manager: { get: () => ({ config: { connection: { timezone } } }) },
      }) as unknown as Database
    for (const timezone of [undefined, 'local', '+02:00'])
      await assert.rejects(
        () => transaction(fakeDb(timezone), async () => {}),
        /requires timezone: 'Z' on the MySQL connection "mysql"/
      )
    for (const timezone of ['Z', '+00:00'])
      await assert.rejects(() => transaction(fakeDb(timezone), async () => {}), /transaction began/)
  })
})
