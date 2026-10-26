import { test } from '@japa/runner'
import { consumeRows } from '../src/consume_rows.js'
import type { Trx } from '../src/types.js'

/**
 * MySQL has no `delete ... returning`, so consumeRows locks the rows and deletes them by id. The
 * SQLite suite drives that path through a query-builder stand-in that records what was asked.
 */
function mysqlTrx(rows: Array<{ id: number }>, deleted: unknown) {
  const log: Array<[string, unknown]> = []
  const builder: Record<string, unknown> = {
    where(...args: unknown[]) {
      log.push(['where', args])
      return builder
    },
    whereIn(column: string, ids: unknown[]) {
      log.push(['whereIn', [column, ids]])
      return builder
    },
    forUpdate() {
      log.push(['forUpdate', null])
      return Promise.resolve(rows)
    },
    delete() {
      log.push(['delete', null])
      return Promise.resolve(deleted)
    },
  }
  const trx = {
    dialect: { name: 'mysql' },
    from(table: string) {
      log.push(['from', table])
      return builder
    },
    rawQuery() {
      throw new Error('MySQL must not use delete ... returning')
    },
  } as unknown as Trx
  return { trx, log }
}

test.group('consuming single-use rows on MySQL', () => {
  test('locks the matching rows, deletes them by id and returns them', async ({ assert }) => {
    const rows = [
      { id: 7, hash: 'a' },
      { id: 9, hash: 'a' },
    ]
    const { trx, log } = mysqlTrx(rows, [2])
    const result = await consumeRows(trx, 'password_reset_tokens', { hash: 'a' }, '2026-01-01')
    assert.deepEqual(result, rows)
    assert.deepEqual(log, [
      ['from', 'password_reset_tokens'],
      ['where', [{ hash: 'a' }]],
      ['where', ['expires_at', '>', '2026-01-01']],
      ['forUpdate', null],
      ['from', 'password_reset_tokens'],
      ['whereIn', ['id', [7, 9]]],
      ['delete', null],
    ])
  })

  test('returns an empty list without deleting when nothing matched', async ({ assert }) => {
    const { trx, log } = mysqlTrx([], 0)
    assert.deepEqual(await consumeRows(trx, 'invitations', { hash: 'x' }, '2026-01-01'), [])
    assert.notInclude(
      log.map(([step]) => step),
      'delete'
    )
  })

  test('fails when the delete removed a different number of rows than were locked', async ({
    assert,
  }) => {
    const { trx } = mysqlTrx([{ id: 1 }, { id: 2 }], 1)
    await assert.rejects(
      () => consumeRows(trx, 'invitations', { hash: 'x' }, '2026-01-01'),
      /invitations rows changed while they were consumed/
    )
  })
})
