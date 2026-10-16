import { performance } from 'node:perf_hooks'
import { test } from '@japa/runner'
import { transaction } from '../src/db.js'
import { PostCommitError } from '../src/errors.js'
import { defineConfig } from '../src/account_kit.js'
import { DateTime } from 'luxon'
import { bootTestApp, useTestApp } from './helpers/app.js'
import { accountKit, makeConfig, makeUsersAdapter } from './helpers/fakes.js'
import { resetSchema } from './helpers/schema.js'
test.group('managed transaction wrapper', (group) => {
  const kit = useTestApp(group)

  test('rejects an active global transaction without changing its connection or writes', async ({
    assert,
  }) => {
    const outer = await kit.db.beginGlobalTransaction()
    const native =
      process.env.DB_CLIENT === 'pg'
        ? null
        : await outer.getWriteClient().client.acquireConnection()
    const timeout = native?.pragma('busy_timeout', { simple: true })
    let callbackCalls = 0
    try {
      await outer
        .table('users')
        .insert({ email: 'outer@example.test', created_at: new Date().toISOString() })
      let failure: Error | undefined
      try {
        await transaction(kit.db, async () => {
          callbackCalls++
        })
      } catch (error) {
        failure = error as Error
      }
      assert.instanceOf(failure, Error)
      assert.equal(callbackCalls, 0)
      assert.isFalse(outer.isCompleted)
      if (native) {
        assert.isTrue(native.inTransaction)
        assert.equal(native.pragma('busy_timeout', { simple: true }), timeout)
      }
      assert.isNotNull(await outer.from('users').where('email', 'outer@example.test').first())
      assert.include(failure!.message, 'requires its own transaction')
      await kit.db.commitGlobalTransaction()
      assert.isNotNull(await kit.db.from('users').where('email', 'outer@example.test').first())
    } finally {
      if (!outer.isCompleted) await kit.db.rollbackGlobalTransaction()
    }
  })

  test('rejects a credential write inside a PostgreSQL global transaction before callbacks or mutation', async ({
    assert,
  }) => {
    if (process.env.DB_CLIENT !== 'pg') return
    const users = makeUsersAdapter(kit.db, kit.hash)
    const user = await kit.db.transaction((trx) =>
      users.create(
        {
          email: 'global@example.test',
          password: 'originalPassword123',
          unverifiedEmail: null,
        },
        trx
      )
    )
    const observer = kit.db.connection().getWriteClient()
    const before = await observer('users').where('id', user.id).first()
    let callbacks = 0
    const account = accountKit(
      kit,
      defineConfig(
        makeConfig({
          users,
          onCredentialsChanged: async () => {
            callbacks++
          },
        })
      )
    )
    const outer = await kit.db.beginGlobalTransaction()
    try {
      await outer.from('users').where('id', user.id).update({ email_verified_at: null })
      await assert.rejects(
        () =>
          account.emailPasswordManagement.changePassword({
            actorId: user.id,
            currentPassword: 'originalPassword123',
            newPassword: 'changedPassword123',
          }),
        /requires its own transaction/
      )
      assert.equal(callbacks, 0)
      const innerRow = await outer.from('users').where('id', user.id).first()
      const externalRow = await observer('users').where('id', user.id).first()
      assert.equal(innerRow.password, before.password)
      assert.equal(externalRow.password, before.password)
      await kit.db.rollbackGlobalTransaction()
      assert.deepEqual(await observer('users').where('id', user.id).first(), before)
    } finally {
      if (!outer.isCompleted) await kit.db.rollbackGlobalTransaction()
    }
  })

  test('rejects a PostgreSQL deferred-constraint COMMIT without commit events or durable writes', async ({
    assert,
  }) => {
    if (process.env.DB_CLIENT !== 'pg') return
    await kit.db
      .rawQuery(
        'CREATE TABLE test_deferred_commit (id integer PRIMARY KEY, user_id integer REFERENCES users(id) DEFERRABLE INITIALLY DEFERRED)'
      )
      .exec()
    let commits = 0
    let rollbacks = 0
    let afterCommits = 0
    let afterRollbacks = 0
    try {
      let failure: unknown
      try {
        await transaction(kit.db, async (trx) => {
          trx.on('commit', () => {
            commits++
          })
          trx.on('rollback', () => {
            rollbacks++
          })
          trx.after('commit', () => {
            afterCommits++
          })
          trx.after('rollback', () => {
            afterRollbacks++
          })
          await trx.table('test_deferred_commit').insert({ id: 1, user_id: -1 })
          return 'claimed committed'
        })
      } catch (error) {
        failure = error
      }
      assert.equal((failure as { code?: string })?.code, '23503')
      assert.equal(commits, 0)
      assert.equal(afterCommits, 0)
      assert.equal(rollbacks, 1)
      assert.equal(afterRollbacks, 1)
      assert.lengthOf(await kit.db.from('test_deferred_commit'), 0)

      await transaction(kit.db, async (trx) => {
        await trx
          .table('users')
          .insert({ email: 'reused@example.test', created_at: DateTime.utc().toISO() })
      })
      assert.isNotNull(await kit.db.from('users').where('email', 'reused@example.test').first())
    } finally {
      await kit.db.connection().schema.dropTableIfExists('test_deferred_commit')
    }
  })

  test('a PostgreSQL commit failure rejects password change and suppresses its post-commit callback', async ({
    assert,
  }) => {
    if (process.env.DB_CLIENT !== 'pg') return
    await kit.db
      .rawQuery(
        'CREATE TABLE test_deferred_commit (id integer PRIMARY KEY, user_id integer REFERENCES users(id) DEFERRABLE INITIALLY DEFERRED)'
      )
      .exec()
    try {
      const users = makeUsersAdapter(kit.db, kit.hash)
      const user = await kit.db.transaction((trx) =>
        users.create(
          {
            email: 'deferred@example.test',
            password: 'originalPassword123',
            unverifiedEmail: null,
          },
          trx
        )
      )
      const observer = kit.db.connection().getWriteClient()
      const before = await observer('users').where('id', user.id).first()
      let callbacks = 0
      const account = accountKit(
        kit,
        defineConfig(
          makeConfig({
            users: {
              ...users,
              async setPassword(...args) {
                await users.setPassword(...args)
                await args[2].table('test_deferred_commit').insert({ id: 1, user_id: -1 })
              },
            },
            onCredentialsChanged: async () => {
              callbacks++
            },
          })
        )
      )
      let failure: unknown
      try {
        await account.emailPasswordManagement.changePassword({
          actorId: user.id,
          currentPassword: 'originalPassword123',
          newPassword: 'changedPassword123',
        })
      } catch (error) {
        failure = error
      }
      assert.equal((failure as { code?: string })?.code, '23503')
      assert.equal(callbacks, 0)
      assert.deepEqual(await observer('users').where('id', user.id).first(), before)
      assert.lengthOf(await observer('test_deferred_commit'), 0)
    } finally {
      await kit.db.connection().schema.dropTableIfExists('test_deferred_commit')
    }
  })

  test('propagates a non-busy error once and rolls back', async ({ assert }) => {
    let attempts = 0
    try {
      await transaction(kit.db, async (trx) => {
        attempts++
        await trx
          .table('users')
          .insert({ email: 'error@example.test', created_at: new Date().toISOString() })
        throw new Error('terminal')
      })
      assert.fail('expected rejection')
    } catch (error) {
      assert.equal((error as Error).message, 'terminal')
    }
    assert.equal(attempts, 1)
    assert.isNull(await kit.db.from('users').where('email', 'error@example.test').first())
  })

  test('waits asynchronously for the SQLite writer before entering the callback', async ({
    assert,
  }) => {
    if (process.env.DB_CLIENT === 'pg') return
    let releaseFirst!: () => void
    let firstWrote!: () => void
    const firstReady = new Promise<void>((resolve) => {
      firstWrote = resolve
    })
    const firstHold = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const first = transaction(kit.db, async (trx) => {
      await trx
        .table('users')
        .insert({ email: 'first@example.test', created_at: new Date().toISOString() })
      firstWrote()
      await firstHold
    })
    await firstReady
    let attempts = 0
    let firstReleased = false
    const second = transaction(kit.db, async (trx) => {
      attempts++
      assert.isTrue(firstReleased)
      await trx
        .table('users')
        .insert({ email: 'second@example.test', created_at: new Date().toISOString() })
    })
    setTimeout(() => {
      firstReleased = true
      releaseFirst()
    }, 80)
    await Promise.all([first, second])
    assert.equal(attempts, 1)
    assert.lengthOf(await kit.db.from('users'), 2)
  })

  test('rolls back partial writes before retry and restores each connection timeout', async ({
    assert,
  }) => {
    if (process.env.DB_CLIENT === 'pg') return
    let attempts = 0
    await transaction(kit.db, async (trx) => {
      attempts++
      const current = await trx.rawQuery('PRAGMA busy_timeout').exec()
      assert.equal(current[0].timeout, 0)
      await trx
        .table('users')
        .insert({ email: 'retry@example.test', created_at: new Date().toISOString() })
      if (attempts === 1) throw Object.assign(new Error('synthetic busy'), { code: 'SQLITE_BUSY' })
    })
    assert.equal(attempts, 2)
    assert.lengthOf(await kit.db.from('users').where('email', 'retry@example.test'), 1)
    await kit.db.transaction(async (trx) => {
      const current = await trx.rawQuery('PRAGMA busy_timeout').exec()
      assert.equal(current[0].timeout, 5000)
    })
  })

  test('stops SQLite busy retries at a bounded deadline', async ({ assert }) => {
    if (process.env.DB_CLIENT === 'pg') return
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
    assert.isBelow(performance.now() - started, 6500)
    await kit.db.transaction(async (trx) => {
      const current = await trx.rawQuery('PRAGMA busy_timeout').exec()
      assert.equal(current[0].timeout, 5000)
    })
  }).timeout(8000)

  test('restores a custom SQLite busy timeout after success and ordinary errors', async ({
    assert,
  }) => {
    if (process.env.DB_CLIENT === 'pg') return
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
  })

  test('requires the installed SQLite lock singleton before entering a one-connection callback', async ({
    assert,
  }) => {
    if (process.env.DB_CLIENT === 'pg') return
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
  })

  test('DELETE-journal commit contention yields to a reader and commits before returning', async ({
    assert,
  }) => {
    if (process.env.DB_CLIENT === 'pg') return
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
    let afterCommits = 0
    let eventSawOpenTransaction = false
    try {
      await resetSchema(customKit)
      await customKit.db.rawQuery('PRAGMA journal_mode = DELETE').exec()
      await customKit.db.table('users').insert({
        email: 'commit@example.test',
        created_at: new Date().toISOString(),
      })
      reader = await customKit.db.transaction()
      await reader.from('users').first()
      let releasedAt = 0
      const started = performance.now()
      const release = new Promise<void>((resolve, reject) => {
        setTimeout(async () => {
          releasedAt = performance.now() - started
          try {
            await reader!.commit()
            resolve()
          } catch (error) {
            reject(error)
          }
        }, 80)
      })
      await transaction(customKit.db, async (trx) => {
        native = await trx.getWriteClient().client.acquireConnection()
        trx.on('commit', () => {
          commits++
          eventSawOpenTransaction ||= native!.inTransaction
        })
        trx.after('commit', () => {
          afterCommits++
        })
        await trx
          .from('users')
          .where('email', 'commit@example.test')
          .update({ email: 'committed@example.test' })
      })
      await release
      assert.isBelow(releasedAt, 500)
      assert.isFalse(native!.inTransaction)
      assert.equal(native!.pragma('busy_timeout', { simple: true }), 5000)
      assert.equal(commits, 1)
      assert.equal(afterCommits, 1)
      assert.isFalse(eventSawOpenTransaction)
      assert.isNotNull(
        await customKit.db.from('users').where('email', 'committed@example.test').first()
      )
      await customKit.db.transaction(async (trx) => {
        const timeout = await trx.rawQuery('PRAGMA busy_timeout').exec()
        assert.equal(timeout[0].timeout, 5000)
      })
    } finally {
      if (native?.inTransaction) native.exec('ROLLBACK')
      if (reader && !reader.isCompleted) await reader.rollback()
      await customKit.close()
    }
  }).timeout(8000)

  test('DELETE-journal commit exhaustion rolls back and releases its pooled connection', async ({
    assert,
  }) => {
    if (process.env.DB_CLIENT === 'pg') return
    const customKit = await bootTestApp({ sqliteBusyTimeout: 5000, sqlitePoolMax: 2 })
    let reader: Awaited<ReturnType<typeof customKit.db.transaction>> | undefined
    const natives: Array<{
      inTransaction: boolean
      exec(sql: string): void
      pragma(sql: string, options?: { simple: boolean }): unknown
    }> = []
    let commits = 0
    let rollbacks = 0
    let afterCommits = 0
    let afterRollbacks = 0
    try {
      await resetSchema(customKit)
      await customKit.db.rawQuery('PRAGMA journal_mode = DELETE').exec()
      await customKit.db
        .table('users')
        .insert({ email: 'before@example.test', created_at: new Date().toISOString() })
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
            afterCommits++
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
      assert.isBelow(performance.now() - started, 6500)
      assert.isAbove(natives.length, 1)
      for (const native of natives) {
        assert.isFalse(native.inTransaction)
        assert.equal(native.pragma('busy_timeout', { simple: true }), 5000)
      }
      assert.equal(commits, 0)
      assert.equal(afterCommits, 0)
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
        await trx
          .table('users')
          .insert({ email: 'reused@example.test', created_at: new Date().toISOString() })
      })
    } finally {
      for (const native of natives) if (native.inTransaction) native.exec('ROLLBACK')
      if (reader && !reader.isCompleted) await reader.rollback()
      await customKit.close()
    }
  }).timeout(8000)

  test('pool-one failed native rollback releases the reservation before a queued read and next write', async ({
    assert,
  }) => {
    if (process.env.DB_CLIENT === 'pg') return
    const customKit = await bootTestApp({ sqlitePoolMax: 1 })
    const client = customKit.db.connection().getWriteClient().client
    const native = (await client.acquireConnection()) as {
      exec(sql: string): void
      inTransaction: boolean
    }
    const original = native.exec.bind(native)
    const rollbackFault = new Error('native rollback failed')
    native.exec = (sql) => {
      if (sql === 'ROLLBACK') throw rollbackFault
      original(sql)
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
      await assert.rejects(() => writing)
      assert.isNull(await reading)
      await customKit.db
        .table('users')
        .insert({ email: 'bruce@example.test', created_at: new Date().toISOString() })
      assert.isNotNull(
        await customKit.db.from('users').where('email', 'bruce@example.test').first()
      )
    } finally {
      native.exec = original
      await customKit.close()
    }
  }).timeout(5000)

  test('pool-one committed timeout restoration fault keeps outcome known and drains queued work', async ({
    assert,
  }) => {
    if (process.env.DB_CLIENT === 'pg') return
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
        await trx
          .table('users')
          .insert({ email: 'diana@example.test', created_at: new Date().toISOString() })
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
        .insert({ email: 'clark@example.test', created_at: new Date().toISOString() })
      assert.isNotNull(
        await customKit.db.from('users').where('email', 'clark@example.test').first()
      )
    } finally {
      native.pragma = original
      await customKit.close()
    }
  }).timeout(5000)

  test('a busy-coded commit listener error does not replay committed writes', async ({
    assert,
  }) => {
    if (process.env.DB_CLIENT === 'pg') return
    const failure = Object.assign(new Error('after commit failed'), { code: 'SQLITE_BUSY' })
    let attempts = 0
    try {
      await transaction(kit.db, async (trx) => {
        attempts++
        await trx.table('users').insert({
          email: 'once@example.test',
          created_at: new Date().toISOString(),
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
  })
})
