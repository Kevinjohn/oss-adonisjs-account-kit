import { test } from '@japa/runner'
import { readIsoTimestamp } from '../src/timestamps.js'
import { useTestApp } from './helpers/app.js'
import { makeService } from './helpers/fakes.js'
import { insertUser } from './helpers/insert_user.js'
import { lockNotAvailableCode, locksRows, testEngine } from './helpers/dialect.js'
import type { AccountAccessSnapshot } from '../src/types.js'

test.group('authentication.inspectAccountAccess concurrency', (group) => {
  const kit = useTestApp(group)

  async function assertUserLockIsHeld(
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

  function startWithBackendId<T>(start: () => Promise<T>): {
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
                testEngine === 'pg'
                  ? 'select pg_backend_pid() as id'
                  : 'select connection_id() as id'
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

  async function waitForDatabaseLockWait(
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

  function createBarrier(label: string) {
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

  test('waits for a restriction writer and returns its committed after-state', async ({
    assert,
  }) => {
    const user = await insertUser(kit)
    const { account } = makeService(kit, {
      authentication: {
        strategy: 'session',
        guard: 'web',
        canAccess: async () => true,
      },
    })
    const writerBarrier = createBarrier('Restriction writer')
    let releaseWriter!: () => void
    const release = new Promise<void>((resolve) => (releaseWriter = resolve))

    const trackedWriter = startWithBackendId(() =>
      account.authentication.changeRestriction({
        userId: user.id,
        change: async (_current, trx) => {
          await trx.from('users').where('id', user.id).update({ unverified_email: user.email })
          writerBarrier.signal()
          await release
        },
      })
    )
    const writer = trackedWriter.operation
    writerBarrier.observe(writer)
    let settled = false
    let trackedReader: ReturnType<typeof startWithBackendId<AccountAccessSnapshot>> | undefined
    const reader = writerBarrier.promise.then(() => {
      trackedReader = startWithBackendId(() =>
        account.authentication.inspectAccountAccess({
          userId: user.id,
          requireActive: false,
        })
      )
      void trackedReader.operation.then(
        () => (settled = true),
        () => (settled = true)
      )
      return trackedReader.operation
    })

    try {
      await writerBarrier.promise
      await assertUserLockIsHeld(assert, user.id)
      if (locksRows) {
        const [readerBackendId, writerBackendId] = await Promise.all([
          trackedReader!.backendId,
          trackedWriter.backendId,
        ])
        await waitForDatabaseLockWait(assert, readerBackendId, writerBackendId)
      }
      assert.isFalse(settled)
    } finally {
      releaseWriter()
      await Promise.all([writer.catch(() => {}), reader.catch(() => {})])
    }

    const [, snapshot] = await Promise.all([writer, reader])
    const row = await kit.db.from('users').where('id', user.id).first()
    assert.isFalse(snapshot.account.active)
    assert.equal(snapshot.account.unverifiedEmail, user.email)
    assert.isNotNull(snapshot.revision)
    assert.equal(snapshot.revision, readIsoTimestamp(row.credentials_changed_at))
  }).timeout(10_000)

  test('holds its row lock through canAccess and returns the before-state', async ({ assert }) => {
    const user = await insertUser(kit)
    const beforeRow = await kit.db.from('users').where('id', user.id).first()
    const beforeRevision = readIsoTimestamp(beforeRow.credentials_changed_at)
    const beforeAccount = {
      id: user.id,
      email: user.email,
      unverifiedEmail: user.unverifiedEmail,
      hasPassword: user.hasPassword,
      active: user.unverifiedEmail !== user.email,
    }
    const readerBarrier = createBarrier('Inspection reader')
    let releaseReader!: () => void
    const release = new Promise<void>((resolve) => (releaseReader = resolve))
    const { account } = makeService(kit, {
      authentication: {
        strategy: 'session',
        guard: 'web',
        canAccess: async () => {
          readerBarrier.signal()
          await release
          return true
        },
      },
    })

    const trackedReader = startWithBackendId(() =>
      account.authentication.inspectAccountAccess({
        userId: user.id,
        requireActive: false,
      })
    )
    const reader = trackedReader.operation
    readerBarrier.observe(reader)
    let writer: Promise<void> | undefined
    let trackedWriter: ReturnType<typeof startWithBackendId<void>> | undefined
    let writerSettled = false

    try {
      await readerBarrier.promise
      await assertUserLockIsHeld(assert, user.id)
      trackedWriter = startWithBackendId(() =>
        account.authentication.changeRestriction({
          userId: user.id,
          change: async () => {},
        })
      )
      writer = trackedWriter.operation
      void writer.then(
        () => (writerSettled = true),
        () => (writerSettled = true)
      )
      if (locksRows) {
        const [writerBackendId, readerBackendId] = await Promise.all([
          trackedWriter.backendId,
          trackedReader.backendId,
        ])
        await waitForDatabaseLockWait(assert, writerBackendId, readerBackendId)
      }
      assert.isFalse(writerSettled)
    } finally {
      releaseReader()
      await Promise.all([reader.catch(() => {}), writer?.catch(() => {})])
    }

    const snapshot = await reader
    await writer
    const afterRow = await kit.db.from('users').where('id', user.id).first()
    assert.deepEqual(snapshot.account, beforeAccount)
    assert.equal(snapshot.revision, beforeRevision)
    assert.notEqual(readIsoTimestamp(afterRow.credentials_changed_at), beforeRevision)
  }).timeout(10_000)
})
