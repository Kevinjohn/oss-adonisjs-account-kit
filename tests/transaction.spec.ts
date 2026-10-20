import { test } from '@japa/runner'
import { transaction } from '../src/db.js'
import { defineConfig } from '../src/account_kit.js'
import { useTestApp } from './helpers/app.js'
import { accountKit, makeConfig, makeUsersAdapter } from './helpers/fakes.js'
import { locksRows } from './helpers/dialect.js'
import { dbTime } from './helpers/db_time.js'

test.group('managed transaction wrapper', (group) => {
  const kit = useTestApp(group)

  test('rejects an active global transaction without changing its connection or writes', async ({
    assert,
  }) => {
    const outer = await kit.db.beginGlobalTransaction()
    const native = locksRows ? null : await outer.getWriteClient().client.acquireConnection()
    const timeout = native?.pragma('busy_timeout', { simple: true })
    let callbackCalls = 0
    try {
      await outer.table('users').insert({ email: 'outer@example.test', created_at: dbTime(kit) })
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
    if (!locksRows) return
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

  test('propagates a non-busy error once and rolls back', async ({ assert }) => {
    let attempts = 0
    try {
      await transaction(kit.db, async (trx) => {
        attempts++
        await trx.table('users').insert({ email: 'error@example.test', created_at: dbTime(kit) })
        throw new Error('terminal')
      })
      assert.fail('expected rejection')
    } catch (error) {
      assert.equal((error as Error).message, 'terminal')
    }
    assert.equal(attempts, 1)
    assert.isNull(await kit.db.from('users').where('email', 'error@example.test').first())
  })
})
