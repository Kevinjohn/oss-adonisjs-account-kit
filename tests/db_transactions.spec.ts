import { performance } from 'node:perf_hooks'
import { test } from '@japa/runner'
import { transaction } from '../src/db.js'
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
          emailVerifiedAt: DateTime.utc(),
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
          account.credentials.changePassword({
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
            emailVerifiedAt: DateTime.utc(),
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
        await account.credentials.changePassword({
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

  test('retries the whole SQLite transaction asynchronously after an overlapping write', async ({
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
    const second = transaction(kit.db, async (trx) => {
      attempts++
      await trx
        .table('users')
        .insert({ email: 'second@example.test', created_at: new Date().toISOString() })
    })
    setTimeout(releaseFirst, 80)
    await Promise.all([first, second])
    assert.isAtLeast(attempts, 2)
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
      assert.equal(error, failure)
    }
    assert.equal(attempts, 1)
    assert.lengthOf(await kit.db.from('users').where('email', 'once@example.test'), 1)
  })
})
