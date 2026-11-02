import { test } from '@japa/runner'
import { clearRows } from './helpers/test_rows.js'

interface FakeOptions {
  previousChecks?: number
  failSql?: string
}

function fakeKit(options: FakeOptions = {}) {
  const calls: Array<{ sql: string; connection: object }> = []
  const connection: {
    destroyed: boolean
    __knex__disposed?: Error
    destroy(): void
  } = {
    destroyed: false,
    destroy() {
      this.destroyed = true
    },
  }
  const failure = new Error(`failed: ${options.failSql}`)
  const trx = {
    knexClient: { client: { acquireConnection: async () => connection } },
    rawQuery(sql: string) {
      return {
        async exec() {
          calls.push({ sql, connection })
          if (sql === options.failSql) throw failure
          if (sql.startsWith('select @@SESSION.foreign_key_checks')) {
            return [[{ foreign_key_checks: options.previousChecks ?? 1 }], []]
          }
          return []
        },
      }
    },
  }
  const kit = {
    db: {
      connection: () => ({ dialect: { name: 'mysql' } }),
      transaction: async (callback: (transaction: typeof trx) => Promise<void>) => {
        try {
          return await callback(trx)
        } catch (error) {
          if (connection.__knex__disposed) connection.destroy()
          throw error
        }
      },
    },
  } as unknown as Parameters<typeof clearRows>[0]

  return { kit, calls, connection, failure }
}

async function rejectionOf(action: () => Promise<void>): Promise<unknown> {
  try {
    await action()
  } catch (error) {
    return error
  }
  throw new Error('expected action to reject')
}

test.group('clearing MySQL test rows', () => {
  test('uses one session and restores its previous setting after success', async ({ assert }) => {
    const { kit, calls, connection } = fakeKit({ previousChecks: 0 })

    await clearRows(kit)

    assert.isAbove(calls.length, 3)
    assert.equal(calls[0].sql, 'select @@SESSION.foreign_key_checks as foreign_key_checks')
    assert.equal(calls[1].sql, 'set SESSION foreign_key_checks = 0')
    assert.equal(calls.at(-1)?.sql, 'set SESSION foreign_key_checks = 0')
    assert.isTrue(calls.every((call) => call.connection === connection))
    assert.isFalse(connection.destroyed)
  })

  test('restores checks when a truncate fails midway', async ({ assert }) => {
    const { kit, calls, failure } = fakeKit({ failSql: 'truncate table social_transactions' })

    assert.isTrue((await rejectionOf(() => clearRows(kit))) === failure)

    assert.equal(calls.at(-1)?.sql, 'set SESSION foreign_key_checks = 1')
  })

  test('attempts restoration when disabling checks reports failure', async ({ assert }) => {
    const { kit, calls, failure } = fakeKit({ failSql: 'set SESSION foreign_key_checks = 0' })

    assert.isTrue((await rejectionOf(() => clearRows(kit))) === failure)

    assert.equal(calls.at(-1)?.sql, 'set SESSION foreign_key_checks = 1')
  })

  test('discards the session when restoration fails', async ({ assert }) => {
    const restoreSql = 'set SESSION foreign_key_checks = 1'
    const { kit, connection, failure } = fakeKit({ failSql: restoreSql })

    assert.isTrue((await rejectionOf(() => clearRows(kit))) === failure)

    assert.instanceOf(connection.__knex__disposed, Error)
    assert.isTrue(connection.destroyed)
  })

  test('retains both truncate and restoration failures', async ({ assert }) => {
    const { calls, connection, failure } = fakeKit({
      failSql: 'truncate table social_transactions',
    })
    const restoreFailure = new Error('restore failed')
    const trx = {
      knexClient: { client: { acquireConnection: async () => connection } },
      rawQuery(sql: string) {
        return {
          async exec() {
            calls.push({ sql, connection })
            if (sql === 'select @@SESSION.foreign_key_checks as foreign_key_checks') {
              return [[{ foreign_key_checks: 1 }], []]
            }
            if (sql === 'set SESSION foreign_key_checks = 1') throw restoreFailure
            if (sql === 'truncate table social_transactions') throw failure
            return []
          },
        }
      },
    }
    const failingKit = {
      db: {
        connection: () => ({ dialect: { name: 'mysql' } }),
        transaction: async (callback: (transaction: typeof trx) => Promise<void>) => {
          try {
            return await callback(trx)
          } catch (error) {
            if (connection.__knex__disposed) connection.destroy()
            throw error
          }
        },
      },
    } as unknown as Parameters<typeof clearRows>[0]

    try {
      await clearRows(failingKit)
      assert.fail('expected clearRows to reject')
    } catch (error) {
      assert.instanceOf(error, AggregateError)
      assert.deepEqual((error as AggregateError).errors, [failure, restoreFailure])
    }
    assert.instanceOf(connection.__knex__disposed, Error)
    assert.isTrue(connection.destroyed)
  })
})
