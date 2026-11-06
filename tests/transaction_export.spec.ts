import { DateTime } from 'luxon'
import { test } from '@japa/runner'
import { lockRow as lockRowSource, transaction as transactionSource } from '../src/db.js'
import {
  readTimestamp as readTimestampSource,
  sqlTimestamp as sqlTimestampSource,
} from '../src/timestamps.js'
import { lockRow, readTimestamp, sqlTimestamp, transaction } from '../transaction/main.js'
import { useTestApp } from './helpers/app.js'
import { insertUser } from './helpers/fakes.js'

test.group('transaction subpath', (group) => {
  const kit = useTestApp(group)

  test('exports the helpers the package uses itself', ({ assert }) => {
    assert.strictEqual(transaction, transactionSource)
    assert.strictEqual(lockRow, lockRowSource)
    assert.strictEqual(sqlTimestamp, sqlTimestampSource)
    assert.strictEqual(readTimestamp, readTimestampSource)
  })

  test('runs a package transaction that locks a row and round-trips a timestamp', async ({
    assert,
  }) => {
    const person = await insertUser(kit)
    const at = DateTime.fromISO('2026-03-04T05:06:07.890Z')
    const seen = await transaction(kit.db, async (trx) => {
      await lockRow(trx, 'users', person.id)
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
