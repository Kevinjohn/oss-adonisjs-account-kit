import { performance } from 'node:perf_hooks'
import { test } from '@japa/runner'
import { bootTestApp } from './helpers/app.js'
import { resetSchema } from './helpers/schema.js'
import { transaction } from '../src/db.js'

test.group('managed transaction wrapper', (group) => {
  let kit: Awaited<ReturnType<typeof bootTestApp>>
  group.setup(async () => {
    kit = await bootTestApp()
  })
  group.each.setup(async () => {
    await resetSchema(kit.db)
    await kit.limiter.clear()
  })
  group.teardown(async () => {
    await kit.close()
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
      await resetSchema(customKit.db)
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
})
