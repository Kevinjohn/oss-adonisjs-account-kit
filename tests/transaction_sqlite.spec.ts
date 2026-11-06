import { performance } from 'node:perf_hooks'
import { test } from '@japa/runner'
import { transaction } from '../src/db.js'
import { PostCommitError } from '../src/errors.js'
import { bootTestApp, useTestApp } from './helpers/app.js'
import { resetSchema } from './helpers/schema.js'
import { locksRows } from './helpers/dialect.js'
import { dbTime } from './helpers/db_time.js'

test.group('managed transaction wrapper', (group) => {
  const kit = useTestApp(group)

  test('waits asynchronously for the SQLite writer before entering the callback', async ({
    assert,
  }) => {
    let releaseFirst!: () => void
    let firstWrote!: () => void
    const firstReady = new Promise<void>((resolve) => {
      firstWrote = resolve
    })
    const firstHold = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const first = transaction(kit.db, async (trx) => {
      await trx.table('users').insert({ email: 'first@example.test', created_at: dbTime(kit) })
      firstWrote()
      await firstHold
    })
    await firstReady
    let attempts = 0
    let firstReleased = false
    const second = transaction(kit.db, async (trx) => {
      attempts++
      assert.isTrue(firstReleased)
      await trx.table('users').insert({ email: 'second@example.test', created_at: dbTime(kit) })
    })
    setTimeout(() => {
      firstReleased = true
      releaseFirst()
    }, 80)
    await Promise.all([first, second])
    assert.equal(attempts, 1)
    assert.lengthOf(await kit.db.from('users'), 2)
  }).skip(locksRows, 'SQLite serializes writers instead of locking rows')

  test('rolls back partial writes before retry and restores each connection timeout', async ({
    assert,
  }) => {
    let attempts = 0
    await transaction(kit.db, async (trx) => {
      attempts++
      const current = await trx.rawQuery('PRAGMA busy_timeout').exec()
      assert.equal(current[0].timeout, 0)
      await trx.table('users').insert({ email: 'retry@example.test', created_at: dbTime(kit) })
      if (attempts === 1) throw Object.assign(new Error('synthetic busy'), { code: 'SQLITE_BUSY' })
    })
    assert.equal(attempts, 2)
    assert.lengthOf(await kit.db.from('users').where('email', 'retry@example.test'), 1)
    await kit.db.transaction(async (trx) => {
      const current = await trx.rawQuery('PRAGMA busy_timeout').exec()
      assert.equal(current[0].timeout, 5000)
    })
  }).skip(locksRows, 'SQLite serializes writers instead of locking rows')

  test('stops SQLite busy retries at a bounded deadline', async ({ assert }) => {
    let attempts = 0
    const started = performance.now()
    try {
      await transaction(kit.db, async () => {
        attempts++
        throw Object.assign(new Error('still busy'), { code: 'SQLITE_BUSY' })
      })
      assert.fail('expected rejection')
    } catch (error) {
      assert.equal((error as Error).message, 'still busy')
    }
    assert.isAbove(attempts, 1)
    assert.isAtLeast(performance.now() - started, 4900)
    // The 5-second deadline plus room for a loaded CI runner.
    assert.isBelow(performance.now() - started, 7500)
    await kit.db.transaction(async (trx) => {
      const current = await trx.rawQuery('PRAGMA busy_timeout').exec()
      assert.equal(current[0].timeout, 5000)
    })
  })
    .skip(locksRows, 'SQLite serializes writers instead of locking rows')
    .timeout(10_000)

  test('restores a custom SQLite busy timeout after success and ordinary errors', async ({
    assert,
  }) => {
    const customKit = await bootTestApp({ sqliteBusyTimeout: 321, sqlitePoolMax: 1 })
    try {
      await resetSchema(customKit)
      await transaction(customKit.db, async (trx) => {
        const current = await trx.rawQuery('PRAGMA busy_timeout').exec()
        assert.equal(current[0].timeout, 0)
      })
      await customKit.db.transaction(async (trx) => {
        const current = await trx.rawQuery('PRAGMA busy_timeout').exec()
        assert.equal(current[0].timeout, 321)
      })

      try {
        await transaction(customKit.db, async (trx) => {
          const current = await trx.rawQuery('PRAGMA busy_timeout').exec()
          assert.equal(current[0].timeout, 0)
          throw new Error('terminal')
        })
        assert.fail('expected rejection')
      } catch (error) {
        assert.equal((error as Error).message, 'terminal')
      }
      await customKit.db.transaction(async (trx) => {
        const current = await trx.rawQuery('PRAGMA busy_timeout').exec()
        assert.equal(current[0].timeout, 321)
      })
    } finally {
      await customKit.close()
    }
  }).skip(locksRows, 'SQLite serializes writers instead of locking rows')

  test('requires the installed SQLite lock singleton before entering a one-connection callback', async ({
    assert,
  }) => {
    const customKit = await bootTestApp({ sqlitePoolMax: 1 })
    try {
      await resetSchema(customKit)
      await customKit.db.from('account_transaction_lock').where('id', 1).delete()
      let entered = false
      await assert.rejects(
        () =>
          transaction(customKit.db, async () => {
            entered = true
          }),
        /transaction lock row is missing/
      )
      assert.isFalse(entered)
      await customKit.db.table('account_transaction_lock').insert({ id: 1, version: 0 })
      await transaction(customKit.db, async () => {
        entered = true
      })
      assert.isTrue(entered)
      await customKit.db.connection().schema.dropTable('account_transaction_lock')
      await assert.rejects(
        () => transaction(customKit.db, async () => {}),
        /transaction lock is missing; run the account_transaction_lock migration/
      )
    } finally {
      await customKit.close()
    }
  }).skip(locksRows, 'SQLite serializes writers instead of locking rows')

  test('DELETE-journal commit contention yields to a reader and commits before returning', async ({
    assert,
  }) => {
    const customKit = await bootTestApp({ sqliteBusyTimeout: 5000, sqlitePoolMax: 2 })
    let reader: Awaited<ReturnType<typeof customKit.db.transaction>> | undefined
    let native:
      | {
          inTransaction: boolean
          exec(sql: string): void
          pragma(sql: string, options?: { simple: boolean }): unknown
        }
      | undefined
    let commits = 0
    let commitHooksRun = 0
    let eventSawOpenTransaction = false
    let knexTransaction:
      | {
          on(
            event: 'query-error',
            listener: (error: unknown, query: { sql?: string }) => void
          ): void
          off(
            event: 'query-error',
            listener: (error: unknown, query: { sql?: string }) => void
          ): void
          connection?: typeof native
        }
      | undefined
    const queryErrorListeners: Array<{
      emitter: NonNullable<typeof knexTransaction>
      listener: (error: unknown, query: { sql?: string }) => void
    }> = []
    let commitBusyObserved = false
    let signalCommitBusy!: () => void
    let failCommitBusy!: (error: Error) => void
    const commitBusy = new Promise<void>((resolve, reject) => {
      signalCommitBusy = resolve
      failCommitBusy = reject
    })
    void commitBusy.catch(() => {})
    let guard: ReturnType<typeof setTimeout> | undefined
    let commitOperation: Promise<unknown> | undefined
    try {
      await resetSchema(customKit)
      await customKit.db.rawQuery('PRAGMA journal_mode = DELETE').exec()
      await customKit.db.table('users').insert({
        email: 'commit@example.test',
        created_at: dbTime(kit),
      })
      reader = await customKit.db.transaction()
      await reader.from('users').first()
      guard = setTimeout(
        () => failCommitBusy(new Error('DELETE-journal COMMIT never reported SQLITE_BUSY')),
        5000
      )
      const operation = transaction(customKit.db, async (trx) => {
        knexTransaction = trx.getWriteClient() as unknown as NonNullable<typeof knexTransaction>
        native = (await trx.getWriteClient().client.acquireConnection()) as typeof native
        const onQueryError = (error: unknown, query: { sql?: string }) => {
          const code = (error as { code?: string } | null)?.code
          if (
            /^\s*commit\b/i.test(query.sql ?? '') &&
            (code === 'SQLITE_BUSY' || code === 'SQLITE_BUSY_SNAPSHOT')
          ) {
            commitBusyObserved = true
            signalCommitBusy()
          }
        }
        knexTransaction.on('query-error', onQueryError)
        queryErrorListeners.push({ emitter: knexTransaction, listener: onQueryError })
        trx.on('commit', () => {
          commits++
          eventSawOpenTransaction ||= native?.inTransaction === true
        })
        trx.after('commit', () => {
          commitHooksRun++
        })
        await trx
          .from('users')
          .where('email', 'commit@example.test')
          .update({ email: 'committed@example.test' })
      })
      commitOperation = operation
      void operation.then(
        () => {
          if (!commitBusyObserved)
            failCommitBusy(new Error('Transaction completed before a busy COMMIT was observed'))
        },
        (error) => {
          if (!commitBusyObserved)
            failCommitBusy(error instanceof Error ? error : new Error(String(error)))
        }
      )
      await commitBusy
      await reader.commit()
      await operation
      assert.isFalse(native!.inTransaction)
      assert.equal(native!.pragma('busy_timeout', { simple: true }), 5000)
      assert.equal(commits, 1)
      assert.equal(commitHooksRun, 1)
      assert.isFalse(eventSawOpenTransaction)
      assert.isNotNull(
        await customKit.db.from('users').where('email', 'committed@example.test').first()
      )
      await customKit.db.transaction(async (trx) => {
        const timeout = await trx.rawQuery('PRAGMA busy_timeout').exec()
        assert.equal(timeout[0].timeout, 5000)
      })
    } finally {
      if (guard) clearTimeout(guard)
      for (const { emitter, listener } of queryErrorListeners) emitter.off('query-error', listener)
      if (reader && !reader.isCompleted) await reader.rollback()
      if (commitOperation) await commitOperation.catch(() => {})
      if (native?.inTransaction) native.exec('ROLLBACK')
      await customKit.close()
    }
  })
    .skip(locksRows, 'SQLite serializes writers instead of locking rows')
    .timeout(8000)

  test('DELETE-journal commit exhaustion rolls back and releases its pooled connection', async ({
    assert,
  }) => {
    const customKit = await bootTestApp({ sqliteBusyTimeout: 5000, sqlitePoolMax: 2 })
    let reader: Awaited<ReturnType<typeof customKit.db.transaction>> | undefined
    const natives: Array<{
      inTransaction: boolean
      exec(sql: string): void
      pragma(sql: string, options?: { simple: boolean }): unknown
    }> = []
    let commits = 0
    let rollbacks = 0
    let commitHooksRun = 0
    let afterRollbacks = 0
    try {
      await resetSchema(customKit)
      await customKit.db.rawQuery('PRAGMA journal_mode = DELETE').exec()
      await customKit.db
        .table('users')
        .insert({ email: 'before@example.test', created_at: dbTime(kit) })
      reader = await customKit.db.transaction()
      await reader.from('users').first()
      const started = performance.now()
      try {
        await transaction(customKit.db, async (trx) => {
          natives.push(await trx.getWriteClient().client.acquireConnection())
          trx.on('commit', () => {
            commits++
          })
          trx.on('rollback', () => {
            rollbacks++
          })
          trx.after('commit', () => {
            commitHooksRun++
          })
          trx.after('rollback', () => {
            afterRollbacks++
          })
          await trx
            .from('users')
            .where('email', 'before@example.test')
            .update({ email: 'after@example.test' })
        })
        assert.fail('expected SQLITE_BUSY')
      } catch (error) {
        for (const native of natives) assert.isFalse(native.inTransaction)
        assert.equal((error as { code?: string }).code, 'SQLITE_BUSY')
      }
      assert.isAtLeast(performance.now() - started, 4900)
      // The 5-second deadline plus room for a loaded CI runner.
      assert.isBelow(performance.now() - started, 7500)
      assert.isAbove(natives.length, 1)
      for (const native of natives) {
        assert.isFalse(native.inTransaction)
        assert.equal(native.pragma('busy_timeout', { simple: true }), 5000)
      }
      assert.equal(commits, 0)
      assert.equal(commitHooksRun, 0)
      assert.equal(rollbacks, natives.length)
      assert.equal(afterRollbacks, natives.length)
      await reader.commit()
      assert.isNotNull(
        await customKit.db.from('users').where('email', 'before@example.test').first()
      )
      assert.isNull(await customKit.db.from('users').where('email', 'after@example.test').first())
      await customKit.db.transaction(async (trx) => {
        const timeout = await trx.rawQuery('PRAGMA busy_timeout').exec()
        assert.equal(timeout[0].timeout, 5000)
        await trx.table('users').insert({ email: 'reused@example.test', created_at: dbTime(kit) })
      })
    } finally {
      for (const native of natives) if (native.inTransaction) native.exec('ROLLBACK')
      if (reader && !reader.isCompleted) await reader.rollback()
      await customKit.close()
    }
  })
    .skip(locksRows, 'SQLite serializes writers instead of locking rows')
    .timeout(10_000)

  test('pool-one failed native rollback releases the reservation before a queued read and next write', async ({
    assert,
  }) => {
    const customKit = await bootTestApp({ sqlitePoolMax: 1 })
    const client = customKit.db.connection().getWriteClient().client
    const native = (await client.acquireConnection()) as {
      exec(sql: string): void
      prepare(sql: string): unknown
      inTransaction: boolean
    }
    const original = native.exec.bind(native)
    const originalPrepare = native.prepare.bind(native)
    const rollbackFault = new Error('native rollback failed')
    // Knex rolls back through prepare(); account kit's cleanup then retries through exec().
    native.exec = (sql) => {
      if (/^rollback/i.test(sql)) throw rollbackFault
      original(sql)
    }
    native.prepare = (sql) => {
      if (/^rollback/i.test(sql)) throw rollbackFault
      return originalPrepare(sql)
    }
    await client.releaseConnection(native)
    let entered!: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    let resume!: () => void
    const held = new Promise<void>((resolve) => {
      resume = resolve
    })
    try {
      await resetSchema(customKit)
      const writing = transaction(customKit.db, async () => {
        entered()
        await held
        throw new Error('work failed')
      })
      await started
      const reading = customKit.db.from('users').first()
      resume()
      const failure = await writing.then(
        () => null,
        (error: unknown) => error
      )
      assert.instanceOf(failure, AggregateError)
      const reasons = (failure as AggregateError).errors.map((error: Error) => error.message)
      assert.equal(reasons[0], 'work failed')
      assert.isTrue(reasons.some((reason: string) => reason.endsWith('native rollback failed')))
      assert.isNull(await reading)
      await customKit.db
        .table('users')
        .insert({ email: 'bruce@example.test', created_at: dbTime(kit) })
      assert.isNotNull(
        await customKit.db.from('users').where('email', 'bruce@example.test').first()
      )
      // The connection left inside its transaction was discarded, not handed back to the pool.
      const next = await client.acquireConnection()
      await client.releaseConnection(next)
      assert.notStrictEqual(next, native)
    } finally {
      native.exec = original
      native.prepare = originalPrepare
      await customKit.close()
    }
  })
    .skip(locksRows, 'SQLite serializes writers instead of locking rows')
    .timeout(5000)

  test('pool-one committed timeout restoration fault keeps outcome known and drains queued work', async ({
    assert,
  }) => {
    const customKit = await bootTestApp({ sqlitePoolMax: 1 })
    const client = customKit.db.connection().getWriteClient().client
    await resetSchema(customKit)
    const native = (await client.acquireConnection()) as {
      pragma(sql: string, options?: { simple: boolean }): unknown
    }
    const original = native.pragma.bind(native)
    const restoreFault = new Error('timeout restoration failed')
    native.pragma = (sql, options) => {
      if (sql === 'busy_timeout = 5000') throw restoreFault
      return original(sql, options)
    }
    await client.releaseConnection(native)
    let entered!: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    let resume!: () => void
    const held = new Promise<void>((resolve) => {
      resume = resolve
    })
    let attempts = 0
    try {
      const writing = transaction(customKit.db, async (trx) => {
        attempts++
        await trx.table('users').insert({ email: 'diana@example.test', created_at: dbTime(kit) })
        entered()
        await held
      })
      await started
      const reading = customKit.db.from('users').where('email', 'diana@example.test').first()
      resume()
      try {
        await writing
        assert.fail('expected postcommit fault')
      } catch (error) {
        assert.instanceOf(error, PostCommitError)
        assert.equal((error as PostCommitError).cause, restoreFault)
      }
      assert.equal(attempts, 1)
      assert.isNotNull(await reading)
      await customKit.db
        .table('users')
        .insert({ email: 'clark@example.test', created_at: dbTime(kit) })
      assert.isNotNull(
        await customKit.db.from('users').where('email', 'clark@example.test').first()
      )
    } finally {
      native.pragma = original
      await customKit.close()
    }
  })
    .skip(locksRows, 'SQLite serializes writers instead of locking rows')
    .timeout(5000)

  test('a busy-coded commit listener error does not replay committed writes', async ({
    assert,
  }) => {
    const failure = Object.assign(new Error('after commit failed'), { code: 'SQLITE_BUSY' })
    let attempts = 0
    try {
      await transaction(kit.db, async (trx) => {
        attempts++
        await trx.table('users').insert({
          email: 'once@example.test',
          created_at: dbTime(kit),
        })
        trx.on('commit', () => {
          throw failure
        })
      })
      assert.fail('expected listener failure')
    } catch (error) {
      assert.instanceOf(error, PostCommitError)
      assert.equal((error as PostCommitError).cause, failure)
    }
    assert.equal(attempts, 1)
    assert.lengthOf(await kit.db.from('users').where('email', 'once@example.test'), 1)
  }).skip(locksRows, 'SQLite serializes writers instead of locking rows')
})
