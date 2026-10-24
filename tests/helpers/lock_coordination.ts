// Coordinates two database connections around a row lock in tests.
import type { TestApp } from './app.js'
import { lockNotAvailableCode, locksRows, testEngine } from './dialect.js'

export async function assertUserLockIsHeld(
  kit: TestApp,
  assert: { equal(actual: unknown, expected: unknown): void },
  userId: number | string
) {
  const sqliteClient = locksRows ? null : kit.db.connection().getWriteClient()
  const native = sqliteClient
    ? ((await sqliteClient.client.acquireConnection()) as {
        pragma: (statement: string, options: { simple: true }) => number | string
        prepare: (statement: string) => { run: (id: number | string) => void }
      })
    : null

  try {
    let conflict: unknown
    try {
      if (locksRows) {
        await kit.db.transaction((trx) =>
          trx.rawQuery('SELECT id FROM users WHERE id = ? FOR UPDATE NOWAIT', [userId]).exec()
        )
      } else {
        const prior = native!.pragma('busy_timeout', { simple: true })
        try {
          native!.pragma('busy_timeout = 0', { simple: true })
          native!.prepare('UPDATE users SET id = id WHERE id = ?').run(userId)
        } finally {
          native!.pragma('busy_timeout = ' + prior, { simple: true })
        }
      }
    } catch (error) {
      conflict = error
    }
    assert.equal((conflict as { code?: string } | undefined)?.code, lockNotAvailableCode)
  } finally {
    if (native) await sqliteClient!.client.releaseConnection(native)
  }
}

export function startWithBackendId<T>(
  kit: TestApp,
  start: () => Promise<T>
): {
  operation: Promise<T>
  backendId: Promise<string>
} {
  if (!locksRows) return { operation: start(), backendId: Promise.resolve('') }

  const database = kit.db
  const originalConnection = database.connection
  const ownConnection = Object.getOwnPropertyDescriptor(database, 'connection')
  let connectionRestored = false
  let settled = false
  let resolveBackendId!: (id: string) => void
  let rejectBackendId!: (error: unknown) => void
  const backendId = new Promise<string>((resolve, reject) => {
    resolveBackendId = resolve
    rejectBackendId = reject
  })
  void backendId.catch(() => {})

  const restoreConnection = () => {
    if (connectionRestored) return
    connectionRestored = true
    if (ownConnection) Object.defineProperty(database, 'connection', ownConnection)
    else delete (database as { connection?: typeof database.connection }).connection
  }
  const resolveId = (id: string) => {
    if (settled) return
    settled = true
    resolveBackendId(id)
  }
  const rejectId = (error: unknown) => {
    if (settled) return
    settled = true
    rejectBackendId(error)
  }

  const wrapTransaction = (queryClient: ReturnType<typeof originalConnection>) => {
    const originalTransaction = queryClient.transaction
    const ownTransaction = Object.getOwnPropertyDescriptor(queryClient, 'transaction')
    let transactionRestored = false
    const restoreTransaction = () => {
      if (transactionRestored) return
      transactionRestored = true
      if (ownTransaction) Object.defineProperty(queryClient, 'transaction', ownTransaction)
      else delete (queryClient as { transaction?: typeof queryClient.transaction }).transaction
    }

    queryClient.transaction = function (
      this: typeof queryClient,
      ...args: Parameters<typeof originalTransaction>
    ) {
      // Restore before awaiting pool acquisition so a concurrent probe cannot intercept itself.
      restoreTransaction()
      let transaction: ReturnType<typeof originalTransaction>
      try {
        transaction = Reflect.apply(originalTransaction, this, args) as typeof transaction
      } catch (error) {
        rejectId(error)
        throw error
      }
      return transaction.then(
        async (trx) => {
          try {
            const query =
              testEngine === 'pg' ? 'select pg_backend_pid() as id' : 'select connection_id() as id'
            const result = await trx.rawQuery(query).exec()
            const row = testEngine === 'mysql' ? result[0][0] : result.rows[0]
            resolveId(String(row.id))
            return trx
          } catch (error) {
            try {
              await trx.rollback()
            } catch (rollbackError) {
              throw new AggregateError(
                [error, rollbackError],
                'Could not capture transaction backend ID'
              )
            }
            rejectId(error)
            throw error
          }
        },
        (error) => {
          rejectId(error)
          throw error
        }
      ) as ReturnType<typeof originalTransaction>
    } as typeof queryClient.transaction
  }

  database.connection = function (
    this: typeof database,
    ...args: Parameters<typeof originalConnection>
  ) {
    // Restore immediately so only this operation receives the instrumented query client.
    restoreConnection()
    let queryClient: ReturnType<typeof originalConnection>
    try {
      queryClient = Reflect.apply(originalConnection, this, args) as typeof queryClient
    } catch (error) {
      rejectId(error)
      throw error
    }
    wrapTransaction(queryClient)
    return queryClient
  } as typeof database.connection

  let operation: Promise<T>
  try {
    operation = start()
  } catch (error) {
    restoreConnection()
    rejectId(error)
    throw error
  }
  void operation.then(
    () => {
      restoreConnection()
      if (!settled)
        rejectId(new Error('Operation completed before its transaction backend ID was captured'))
    },
    (error) => {
      restoreConnection()
      rejectId(error)
    }
  )
  return { operation, backendId }
}

export async function waitForDatabaseLockWait(
  kit: TestApp,
  assert: { isAtLeast(actual: number, expected: number): void },
  waitingBackendId: string,
  blockingBackendId: string
) {
  const deadline = Date.now() + 5_000
  let waiting = 0
  while (Date.now() < deadline) {
    if (testEngine === 'pg') {
      const result = await kit.db
        .rawQuery(
          `select count(*) as waiting from pg_stat_activity as waiter
           where waiter.pid = ? and waiter.datname = current_database()
             and waiter.wait_event_type = 'Lock'
             and ? = any(pg_blocking_pids(waiter.pid))`,
          [waitingBackendId, blockingBackendId]
        )
        .exec()
      waiting = Number(result.rows[0].waiting)
    } else if (testEngine === 'mysql') {
      const result = await kit.db
        .rawQuery(
          `select count(*) as waiting
           from performance_schema.data_lock_waits as waits
           join performance_schema.threads as waiter
             on waiter.thread_id = waits.requesting_thread_id
           join performance_schema.threads as blocker
             on blocker.thread_id = waits.blocking_thread_id
           join performance_schema.data_locks as requested
             on requested.engine = waits.engine
            and requested.engine_lock_id = waits.requesting_engine_lock_id
            and requested.thread_id = waits.requesting_thread_id
           where waiter.processlist_id = ? and blocker.processlist_id = ?
             and requested.object_schema = database()
             and requested.object_name = 'users'
             and requested.lock_status = 'WAITING'`,
          [waitingBackendId, blockingBackendId]
        )
        .exec()
      waiting = Number(result[0][0].waiting)
    }
    if (waiting >= 1) break
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  assert.isAtLeast(waiting, 1)
}

export function createBarrier(label: string) {
  let resolve!: () => void
  let reject!: (error: unknown) => void
  let reached = false
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return {
    promise,
    signal() {
      reached = true
      resolve()
    },
    observe(operation: Promise<unknown>) {
      void operation.then(() => {
        if (!reached) reject(new Error(`${label} completed before reaching its lock barrier`))
      }, reject)
    },
  }
}
