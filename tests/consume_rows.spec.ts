import { test } from '@japa/runner'
import { DateTime } from 'luxon'
import { consumeRows, deleteReturning, deletedCount } from '../src/consume_rows.js'
import { transaction } from '../src/db.js'
import { useTestApp } from './helpers/app.js'
import { dbTime } from './helpers/db_time.js'
import { insertUser } from './helpers/fakes.js'
import { testEngine } from './helpers/dialect.js'

test.group('consuming single-use rows', (group) => {
  const kit = useTestApp(group)

  async function seed(userId: number | string, hash: string, expiresAt: DateTime) {
    await kit.db.table('password_reset_tokens').insert({
      tokenable_id: userId,
      email: 'person@example.test',
      hash,
      expires_at: dbTime(kit, expiresAt),
      created_at: dbTime(kit),
    })
  }

  test('deletes and returns only the live matching row, once', async ({ assert }) => {
    const user = await insertUser(kit)
    const other = await insertUser(kit, { email: 'other@example.test' })
    await seed(user.id, 'a'.repeat(64), DateTime.utc().plus({ hours: 1 }))
    await seed(other.id, 'b'.repeat(64), DateTime.utc().minus({ hours: 1 }))
    const consume = (hash: string) =>
      transaction(kit.db, (trx) =>
        consumeRows<{ tokenable_id: unknown; hash: string }>(
          trx,
          'password_reset_tokens',
          { hash },
          dbTime(kit)
        )
      )

    const rows = await consume('a'.repeat(64))
    assert.lengthOf(rows, 1)
    assert.equal(rows[0].hash, 'a'.repeat(64))
    assert.equal(rows[0].tokenable_id, user.id)
    assert.deepEqual(await consume('a'.repeat(64)), [])
    assert.deepEqual(await consume('b'.repeat(64)), [], 'an expired row is not consumed')
    assert.lengthOf(await kit.db.from('password_reset_tokens'), 1)
  })

  test('matches every column of the filter', async ({ assert }) => {
    const user = await insertUser(kit)
    await seed(user.id, 'c'.repeat(64), DateTime.utc().plus({ hours: 1 }))
    const rows = await transaction(kit.db, (trx) =>
      consumeRows(
        trx,
        'password_reset_tokens',
        { hash: 'c'.repeat(64), email: 'someone-else@example.test' },
        dbTime(kit)
      )
    )
    assert.deepEqual(rows, [])
    assert.lengthOf(await kit.db.from('password_reset_tokens'), 1)
  })

  test('counts deleted rows from either driver shape', ({ assert }) => {
    assert.equal(deletedCount(3), 3)
    assert.equal(deletedCount([2]), 2)
  })

  test('deleteReturning normalises both driver result shapes', async ({ assert }) => {
    const client = (result: unknown) =>
      ({ rawQuery: () => ({ exec: async () => result }) }) as unknown as Parameters<
        typeof deleteReturning
      >[0]
    assert.deepEqual(await deleteReturning(client([{ id: 1 }]), 'sql', []), [{ id: 1 }])
    assert.deepEqual(await deleteReturning(client({ rows: [{ id: 2 }] }), 'sql', []), [{ id: 2 }])
  })

  test('deleteReturning returns the deleted rows from the real database', async ({ assert }) => {
    // MySQL has no RETURNING; consumeRows covers it.
    if (testEngine === 'mysql') return
    await kit.db.table('users').insert({ email: 'gone@example.test', created_at: new Date() })
    const rows = await deleteReturning<{ email: string }>(
      kit.db,
      'delete from users where email = ? returning email',
      ['gone@example.test']
    )
    assert.deepEqual(rows, [{ email: 'gone@example.test' }])
  })
})
