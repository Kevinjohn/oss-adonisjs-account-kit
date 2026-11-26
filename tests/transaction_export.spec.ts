import { DateTime } from 'luxon'
import { test } from '@japa/runner'
import {
  readTimestamp as readTimestampSource,
  sqlTimestamp as sqlTimestampSource,
} from '../src/timestamps.ts'
import { readTimestamp, sqlTimestamp, TransactionManager } from '../src/transaction/main.ts'
import { useTestApp } from './helpers/app.ts'
import { insertUser } from './helpers/fakes.ts'

test.group('transaction subpath', (group) => {
  const kit = useTestApp(group)

  test('exports the helpers the package uses itself', ({ assert }) => {
    assert.strictEqual(sqlTimestamp, sqlTimestampSource)
    assert.strictEqual(readTimestamp, readTimestampSource)
  })

  test('runs a package transaction that locks a row and round-trips a timestamp', async ({
    assert,
  }) => {
    const person = await insertUser(kit)
    const at = DateTime.fromISO('2026-03-04T05:06:07.890Z')
    const transactions = new TransactionManager(kit.db)
    const seen = await transactions.run(async (trx) => {
      await transactions.lockRow(trx, 'users', person.id)
      await trx
        .from('users')
        .where('id', person.id)
        .update({ email_verified_at: sqlTimestamp(trx, at) })
      const row = await trx.from('users').where('id', person.id).first()
      return readTimestamp(row.email_verified_at)
    })
    assert.equal(seen?.toMillis(), at.toMillis())
    const committed = await kit.db.from('users').where('id', person.id).first()
    assert.equal(readTimestamp(committed.email_verified_at)?.toMillis(), at.toMillis())
  })
})
