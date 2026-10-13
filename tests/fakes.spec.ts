import { DateTime } from 'luxon'
import { test } from '@japa/runner'
import { bootTestApp } from './helpers/app.js'
import { resetSchema } from './helpers/schema.js'
import { allowAll, denyAll, makeConfig, makeNotify, makeUsersAdapter } from './helpers/fakes.js'

test.group('database users adapter', (group) => {
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

  test('creates normalized verified users with a hashed password and reads under a lock', async ({
    assert,
  }) => {
    const users = makeUsersAdapter(kit.db, kit.hash)
    const at = DateTime.utc()
    const created = await kit.db.transaction((trx) =>
      users.create({ email: '  A@Example.Test  ', password: 'secret123', emailVerifiedAt: at }, trx)
    )
    assert.equal(created.email, 'a@example.test')
    assert.isTrue(created.hasPassword)
    assert.equal(created.emailVerifiedAt?.toISO(), at.toISO())
    const stored = await kit.db.from('users').where('id', created.id).first()
    assert.notEqual(stored.password, 'secret123')
    await kit.db.transaction(async (trx) => {
      const found = await users.findByEmail(' A@EXAMPLE.TEST ', trx, { forUpdate: true })
      assert.equal(found?.id, created.id)
      assert.isTrue(await users.verifyPassword(created.id, 'secret123', trx))
      assert.isFalse(await users.verifyPassword(created.id, 'wrong', trx))
    })
  })

  test('rolls back every adapter write supplied a transaction', async ({ assert }) => {
    const users = makeUsersAdapter(kit.db, kit.hash)
    const at = DateTime.utc()
    const existing = await kit.db.transaction((trx) =>
      users.create(
        { email: 'before@example.test', password: 'before123', emailVerifiedAt: at },
        trx
      )
    )
    try {
      await kit.db.transaction(async (trx) => {
        await users.create(
          { email: 'new@example.test', password: 'new12345', emailVerifiedAt: at },
          trx
        )
        await users.setPassword(existing.id, 'changed123', trx)
        await users.setEmail(existing.id, 'changed@example.test', trx)
        await users.markEmailVerified(existing.id, at.plus({ days: 1 }), trx)
        throw new Error('rollback')
      })
    } catch (error) {
      assert.equal((error as Error).message, 'rollback')
    }
    assert.isNull(await users.findByEmail('new@example.test'))
    assert.isNull(await users.findByEmail('changed@example.test'))
    const unchanged = await users.findById(existing.id)
    assert.equal(unchanged?.email, 'before@example.test')
    assert.equal(unchanged?.emailVerifiedAt?.toMillis(), at.toMillis())
    await kit.db.transaction(async (trx) => {
      assert.isTrue(await users.verifyPassword(existing.id, 'before123', trx))
      assert.isFalse(await users.verifyPassword(existing.id, 'changed123', trx))
    })
  })

  test('supplies callbacks and records notification failures on demand', async ({ assert }) => {
    const users = makeUsersAdapter(kit.db, kit.hash)
    const config = makeConfig({ users })
    assert.equal(config.users, users)
    assert.isTrue(
      await allowAll.listInvitations({
        id: 1,
        email: 'a@example.test',
        hasPassword: false,
        emailVerifiedAt: null,
      })
    )
    assert.isFalse(
      await denyAll.listInvitations({
        id: 1,
        email: 'a@example.test',
        hasPassword: false,
        emailVerifiedAt: null,
      })
    )
    const recorder = makeNotify()
    const user = { id: 1, email: 'a@example.test', hasPassword: false, emailVerifiedAt: null }
    await recorder.notify.recovery(user, 'https://example.test/reset')
    recorder.failOn('verification')
    try {
      await recorder.notify.verification(user, 'https://example.test/verify')
      assert.fail('expected notification failure')
    } catch (error) {
      assert.equal((error as Error).message, 'notify.verification failed')
    }
    assert.deepEqual(
      recorder.calls.map((call) => call.method),
      ['recovery', 'verification']
    )
  })
})
