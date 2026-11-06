import { test } from '@japa/runner'
import { consumeRows } from '../src/consume_rows.js'
import type { Trx } from '../src/types.js'

/**
 * MySQL has no `delete ... returning`, so consumeRows finds the ids, locks those rows by primary
 * key, rechecks them and deletes them by id. The SQLite suite drives that path through a
 * query-builder stand-in that records what was asked; `rows` are what the locked read returns.
 */
function mysqlTrx(rows: Array<{ id: number } & Record<string, unknown>>, deleted: unknown) {
  const log: Array<[string, unknown]> = []
  const builder: Record<string, unknown> = {
    where(...args: unknown[]) {
      log.push(['where', args])
      return builder
    },
    select(...columns: unknown[]) {
      log.push(['select', columns])
      return Promise.resolve(rows.map(({ id }) => ({ id })))
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
      { id: 7, hash: 'a', expires_at: '2026-01-02 00:00:00' },
      { id: 9, hash: 'a', expires_at: '2026-01-02 00:00:00' },
    ]
    const { trx, log } = mysqlTrx(rows, [2])
    const result = await consumeRows(trx, 'password_reset_tokens', { hash: 'a' }, '2026-01-01')
    assert.deepEqual(result, rows)
    // Locks first, then deletes exactly the locked ids.
    const steps = log.map(([step]) => step)
    const deleted = steps.lastIndexOf('delete')
    assert.isAbove(deleted, steps.indexOf('forUpdate'))
    assert.isAbove(steps.indexOf('forUpdate'), -1)
    assert.deepEqual(log[deleted - 1], ['whereIn', ['id', [7, 9]]])
  })

  test('drops a locked row that changed after the unlocked lookup', async ({ assert }) => {
    const { trx, log } = mysqlTrx(
      [
        { id: 7, hash: 'a', expires_at: '2026-01-02 00:00:00' },
        { id: 9, hash: 'replaced', expires_at: '2026-01-02 00:00:00' },
        { id: 11, hash: 'a', expires_at: '2025-12-31 00:00:00' },
      ],
      [1]
    )
    const result = await consumeRows(trx, 'invitations', { hash: 'a' }, '2026-01-01 00:00:00')
    assert.deepEqual(
      result.map((row) => (row as { id: number }).id),
      [7]
    )
    assert.deepInclude(log, ['whereIn', ['id', [7]]])
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
    const { trx } = mysqlTrx(
      [
        { id: 1, hash: 'x', expires_at: '2026-01-02 00:00:00' },
        { id: 2, hash: 'x', expires_at: '2026-01-02 00:00:00' },
      ],
      1
    )
    await assert.rejects(
      () => consumeRows(trx, 'invitations', { hash: 'x' }, '2026-01-01'),
      /invitations rows changed while they were consumed/
    )
  })
})
