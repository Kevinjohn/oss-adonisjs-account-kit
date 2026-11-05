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

  test('every MySQL session must run at UTC', async ({ assert }) => {
    const fakeDb = (zone: string | Error) => {
      const calls: string[] = []
      const trx = {
        rawQuery: async () => {
          if (zone instanceof Error) throw zone
          return [[{ zone }]]
        },
        rollback: async () => void calls.push('rollback'),
        // Reached only once the zone check lets the transaction through.
        getWriteClient: () => {
          throw new Error('zone accepted')
        },
      }
      const db = {
        connection: () => ({
          isTransaction: false,
          connectionName: 'mysql',
          dialect: { name: 'mysql' },
          transaction: async () => trx,
        }),
        manager: { get: () => ({ config: { connection: { timezone: 'Z' } } }) },
      } as unknown as Database
      return { db, calls }
    }
    for (const zone of ['SYSTEM', 'Europe/London', '+01:00']) {
      const { db, calls } = fakeDb(zone)
      await assert.rejects(
        () => transaction(db, async () => {}),
        /requires time_zone '\+00:00' on every session of the MySQL connection "mysql"/
      )
      assert.deepEqual(calls, ['rollback'])
    }
    for (const zone of ['+00:00', 'UTC']) {
      const { db } = fakeDb(zone)
      await assert.rejects(() => transaction(db, async () => {}), /zone accepted/)
    }
    // A probe that fails still releases the transaction it opened.
    const { db, calls } = fakeDb(new Error('probe failed'))
    await assert.rejects(() => transaction(db, async () => {}), /probe failed/)
    assert.deepEqual(calls, ['rollback'])
  })

  test('a SQLite connection must use better-sqlite3', async ({ assert }) => {
    for (const name of ['sqlite3', 'libsql'])
      await assert.rejects(
        () =>
          transaction(
            {
              connection: () => ({
                isTransaction: false,
                connectionName: 'sqlite',
                dialect: { name },
                transaction: async () => {
                  throw new Error('transaction began')
                },
              }),
            } as unknown as Database,
            async () => {}
          ),
        new RegExp(`better-sqlite3 only; the connection "sqlite" uses ${name}`)
      )
  })
})
