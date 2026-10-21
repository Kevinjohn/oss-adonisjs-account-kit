import { test } from '@japa/runner'
import { transaction } from '../src/db.js'
import { defineConfig } from '../src/account_kit.js'
import { DateTime } from 'luxon'
import { useTestApp } from './helpers/app.js'
import { accountKit, makeConfig, makeUsersAdapter } from './helpers/fakes.js'
import { testEngine } from './helpers/dialect.js'
import { dbTime } from './helpers/db_time.js'

test.group('managed transaction wrapper', (group) => {
  const kit = useTestApp(group)

  test('rejects a PostgreSQL deferred-constraint COMMIT without commit events or durable writes', async ({
    assert,
  }) => {
    if (testEngine !== 'pg') return
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
          .insert({ email: 'reused@example.test', created_at: dbTime(kit, DateTime.utc()) })
      })
      assert.isNotNull(await kit.db.from('users').where('email', 'reused@example.test').first())
    } finally {
      await kit.db.connection().schema.dropTableIfExists('test_deferred_commit')
    }
  })

  test('a PostgreSQL commit failure rejects password change and suppresses its post-commit callback', async ({
    assert,
  }) => {
    if (testEngine !== 'pg') return
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
})
