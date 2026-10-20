import { test } from '@japa/runner'
import {
  IdentityNotConfirmedError,
  InvalidInputError,
  InvalidTokenError,
  NoPasswordError,
  PostCommitError,
  ThrottledError,
} from '../src/errors.js'
import type { AccountUser } from '../src/types.js'
import { useTestApp } from './helpers/app.js'
import { makeNotify, makeUsersAdapter } from './helpers/fakes.js'
import { credentialsFixtures } from './helpers/credentials.js'
import { locksRows, lockNotAvailableCode } from './helpers/dialect.js'
test.group('emailPasswordManagement', (group) => {
  const kit = useTestApp(group)
  const { createUser, service, seedTokens } = credentialsFixtures(kit)

  test('validates the new password before throttle or user lookup', async ({ assert }) => {
    const user = await createUser()
    let lookups = 0
    const users = makeUsersAdapter(kit.db, kit.hash)
    const account = service({
      users: {
        ...users,
        async findById(...args) {
          lookups++
          return users.findById(...args)
        },
      },
    })
    for (const value of [null, 'short', 'x'.repeat(257)])
      await assert.rejects(
        () =>
          account.emailPasswordManagement.changePassword({
            actorId: user.id,
            currentPassword: 'oldPassword123',
            newPassword: value as never,
          }),
        InvalidInputError
      )
    assert.equal(lookups, 0)
    assert.deepEqual(
      await account.emailPasswordManagement.changePassword({
        actorId: user.id,
        currentPassword: 'oldPassword123',
        newPassword: 'newPassword123',
      }),
      { revision: null }
    )
  })

  test('applies the shared policy to a new password without narrowing current-password login', async ({
    assert,
  }) => {
    const user = await createUser()
    const account = service({ passwordPolicy: { mixedCase: true, numbers: true, minScore: 3 } })
    await assert.rejects(
      () =>
        account.emailPasswordManagement.changePassword({
          actorId: user.id,
          currentPassword: 'oldPassword123',
          newPassword: 'password123',
        }),
      InvalidInputError
    )
    await account.emailPasswordManagement.changePassword({
      actorId: user.id,
      currentPassword: 'oldPassword123',
      newPassword: 'LongerPassword12345',
    })
  })

  test('missing actor and missing or wrong proof reject without changing a password', async ({
    assert,
  }) => {
    const user = await createUser()
    const account = service()
    await assert.rejects(
      () =>
        account.emailPasswordManagement.changePassword({
          actorId: 99999,
          currentPassword: 'oldPassword123',
          newPassword: 'newPassword123',
        }),
      InvalidInputError
    )
    for (const currentPassword of [undefined, '', 'incorrect'])
      await assert.rejects(
        () =>
          account.emailPasswordManagement.changePassword({
            actorId: user.id,
            currentPassword: currentPassword as never,
            newPassword: 'newPassword123',
          }),
        IdentityNotConfirmedError
      )
    const row = await kit.db.from('users').where('id', user.id).first()
    assert.isTrue(await kit.hash.verify(row.password, 'oldPassword123'))
    assert.isFalse(await kit.hash.verify(row.password, 'newPassword123'))
  })

  test('a social account cannot change a password without one', async ({ assert }) => {
    const user = await createUser(true)
    const account = service()
    await assert.rejects(
      () =>
        account.emailPasswordManagement.changePassword({
          actorId: user.id,
          currentPassword: 'anything',
          newPassword: 'newPassword123',
        }),
      NoPasswordError
    )
    const row = await kit.db.from('users').where('id', user.id).first()
    assert.isNull(row.password)
  })

  test('sixth identity attempt throttles before lookup or proof', async ({ assert }) => {
    const user = await createUser()
    const users = makeUsersAdapter(kit.db, kit.hash)
    let lookups = 0
    let proofs = 0
    const account = service({
      users: {
        ...users,
        async findById(...args) {
          lookups++
          return users.findById(...args)
        },
        async verifyPassword(...args) {
          proofs++
          return users.verifyPassword(...args)
        },
      },
    })
    for (let index = 0; index < 5; index++)
      await assert.rejects(
        () =>
          account.emailPasswordManagement.changePassword({
            actorId: user.id,
            currentPassword: 'wrong',
            newPassword: 'newPassword123',
          }),
        IdentityNotConfirmedError
      )
    try {
      await account.emailPasswordManagement.changePassword({
        actorId: user.id,
        currentPassword: 'oldPassword123',
        newPassword: 'newPassword123',
      })
      assert.fail('expected throttle')
    } catch (error) {
      assert.instanceOf(error, ThrottledError)
      assert.isAbove((error as ThrottledError).retryAfterSeconds, 0)
    }
    assert.equal(lookups, 5)
    assert.equal(proofs, 5)
  })

  test('hashes a new password, invalidates both token kinds, and calls back once after durable reload', async ({
    assert,
  }) => {
    const user = await createUser()
    await seedTokens(user)
    const users = makeUsersAdapter(kit.db, kit.hash)
    let callbacks = 0
    let sawCommitted = false
    let callbackUser: AccountUser | undefined
    const account = service({
      users: {
        ...users,
        async setPassword(...args) {
          await users.setPassword(...args)
          await args[2].from('users').where('id', args[0]).update({ email_verified_at: null })
        },
      },
      onCredentialsChanged: async (changed) => {
        callbacks++
        callbackUser = changed
        const row = await kit.db.from('users').where('id', changed.id).first()
        sawCommitted = await kit.hash.verify(row.password, 'newPassword123')
        assert.lengthOf(
          await kit.db.from('password_reset_tokens').where('tokenable_id', changed.id),
          0
        )
        assert.lengthOf(
          await kit.db.from('email_verification_tokens').where('tokenable_id', changed.id),
          0
        )
      },
    })
    assert.deepEqual(
      await account.emailPasswordManagement.changePassword({
        actorId: user.id,
        currentPassword: 'oldPassword123',
        newPassword: 'newPassword123',
      }),
      { revision: null }
    )
    const row = await kit.db.from('users').where('id', user.id).first()
    assert.isTrue(await kit.hash.verify(row.password, 'newPassword123'))
    assert.isFalse(await kit.hash.verify(row.password, 'oldPassword123'))
    assert.equal(callbacks, 1)
    assert.isTrue(sawCommitted)
    assert.equal(callbackUser?.id, user.id)
    assert.isTrue(callbackUser!.hasPassword)
    assert.isNull(callbackUser!.emailVerifiedAt)
  })

  test('postcommit callback failure preserves the password change and invalidation', async ({
    assert,
  }) => {
    const user = await createUser()
    await seedTokens(user)
    const failure = new Error('callback failed')
    const account = service({
      onCredentialsChanged: async () => {
        throw failure
      },
    })
    try {
      await account.emailPasswordManagement.changePassword({
        actorId: user.id,
        currentPassword: 'oldPassword123',
        newPassword: 'newPassword123',
      })
      assert.fail('expected callback failure')
    } catch (error) {
      assert.instanceOf(error, PostCommitError)
      assert.equal((error as PostCommitError).cause, failure)
    }
    const row = await kit.db.from('users').where('id', user.id).first()
    assert.isTrue(await kit.hash.verify(row.password, 'newPassword123'))
    assert.lengthOf(await kit.db.from('password_reset_tokens'), 0)
    assert.lengthOf(await kit.db.from('email_verification_tokens'), 0)
  })

  test('accepts 256 UTF-16 units for a password change', async ({ assert }) => {
    const user = await createUser()
    const password = '😀'.repeat(128)
    await service().emailPasswordManagement.changePassword({
      actorId: user.id,
      currentPassword: 'oldPassword123',
      newPassword: password,
    })
    const row = await kit.db.from('users').where('id', user.id).first()
    assert.isTrue(await kit.hash.verify(row.password, password))
  })

  test('runs all password follow-ups once after a verified commit listener fault', async ({
    assert,
  }) => {
    const user = await createUser()
    const failure = new Error('listener failed after commit')
    const calls: string[] = []
    const account = service({
      onCredentialsChangedTransaction: async (_user, _context, trx) => {
        trx.on('commit', () => {
          throw failure
        })
      },
      onLifecycleEvent: async () => {
        calls.push('lifecycle')
      },
      notify: {
        ...makeNotify().notify,
        passwordChanged: async () => {
          calls.push('notice')
        },
      },
    })
    try {
      await account.emailPasswordManagement.changePassword({
        actorId: user.id,
        currentPassword: 'oldPassword123',
        newPassword: 'newPassword123',
      })
      assert.fail('expected committed failure')
    } catch (error) {
      assert.instanceOf(error, PostCommitError)
      assert.isTrue((error as PostCommitError).committed)
      assert.equal((error as PostCommitError).cause, failure)
    }
    assert.deepEqual(calls, ['notice', 'lifecycle'])
    const row = await kit.db.from('users').where('id', user.id).first()
    assert.isTrue(await kit.hash.verify(row.password, 'newPassword123'))
  })

  test('an adapter write followed by throw rolls back password and token deletions', async ({
    assert,
  }) => {
    const user = await createUser()
    await seedTokens(user)
    const users = makeUsersAdapter(kit.db, kit.hash)
    const failure = new Error('setPassword failed')
    let callbacks = 0
    const account = service({
      users: {
        ...users,
        async setPassword(...args) {
          await users.setPassword(...args)
          throw failure
        },
      },
      onCredentialsChanged: async () => {
        callbacks++
      },
    })
    try {
      await account.emailPasswordManagement.changePassword({
        actorId: user.id,
        currentPassword: 'oldPassword123',
        newPassword: 'newPassword123',
      })
      assert.fail('expected adapter failure')
    } catch (error) {
      assert.equal(error, failure)
    }
    const row = await kit.db.from('users').where('id', user.id).first()
    assert.isTrue(await kit.hash.verify(row.password, 'oldPassword123'))
    assert.isFalse(await kit.hash.verify(row.password, 'newPassword123'))
    assert.lengthOf(await kit.db.from('password_reset_tokens'), 1)
    assert.lengthOf(await kit.db.from('email_verification_tokens'), 1)
    assert.equal(callbacks, 0)
  })

  test('holds the user lock throughout password proof', async ({ assert }) => {
    const user = await createUser()
    const users = makeUsersAdapter(kit.db, kit.hash)
    let proofReady!: () => void
    let releaseProof!: () => void
    const ready = new Promise<void>((resolve) => {
      proofReady = resolve
    })
    const hold = new Promise<void>((resolve) => {
      releaseProof = resolve
    })
    const account = service({
      users: {
        ...users,
        async verifyPassword(...args) {
          const valid = await users.verifyPassword(...args)
          proofReady()
          await hold
          return valid
        },
      },
    })
    const sqliteClient = locksRows ? null : kit.db.connection().getWriteClient()
    const native = sqliteClient
      ? ((await sqliteClient.client.acquireConnection()) as {
          pragma: (statement: string, options: { simple: true }) => number | string
          prepare: (statement: string) => { run: (id: string | number) => void }
        })
      : null
    if (native) assert.equal(native.pragma('journal_mode', { simple: true }), 'wal')
    const changing = account.emailPasswordManagement.changePassword({
      actorId: user.id,
      currentPassword: 'oldPassword123',
      newPassword: 'newPassword123',
    })
    try {
      await ready
      let conflict: unknown
      try {
        if (locksRows) {
          await kit.db.transaction(async (trx) => {
            await trx
              .rawQuery('SELECT id FROM users WHERE id = ? FOR UPDATE NOWAIT', [user.id])
              .exec()
          })
        } else {
          const prior = native!.pragma('busy_timeout', { simple: true })
          try {
            native!.pragma('busy_timeout = 0', { simple: true })
            native!.prepare('UPDATE users SET id = id WHERE id = ?').run(user.id)
          } finally {
            native!.pragma(`busy_timeout = ${prior}`, { simple: true })
          }
        }
      } catch (error) {
        conflict = error
      }
      assert.equal((conflict as { code?: string } | undefined)?.code, lockNotAvailableCode)
    } finally {
      releaseProof()
      await changing.catch(() => {})
      if (native) await sqliteClient!.client.releaseConnection(native)
    }
  })

  test('a password change and independent password reset serialize without a database error', async ({
    assert,
  }) => {
    const user = await createUser()
    const recoveryToken = await seedTokens(user)
    const users = makeUsersAdapter(kit.db, kit.hash)
    let proofReady!: () => void
    let releaseProof!: () => void
    const ready = new Promise<void>((resolve) => {
      proofReady = resolve
    })
    const hold = new Promise<void>((resolve) => {
      releaseProof = resolve
    })
    let callbackCalls = 0
    const account = service({
      onCredentialsChanged: async () => {
        callbackCalls++
      },
      users: {
        ...users,
        async verifyPassword(...args) {
          const valid = await users.verifyPassword(...args)
          proofReady()
          await hold
          return valid
        },
      },
    })
    const changing = account.emailPasswordManagement.changePassword({
      actorId: user.id,
      currentPassword: 'oldPassword123',
      newPassword: 'changedPassword123',
    })
    await ready
    const knex = kit.db.connection().getWriteClient()
    let attempted!: () => void
    const attemptedUserLock = new Promise<void>((resolve) => {
      attempted = resolve
    })
    const onQuery = (query: { sql: string }) => {
      if (
        /select .*users.*for update|update ["`]?account_transaction_lock["`]? set version = version/i.test(
          query.sql
        )
      )
        attempted()
    }
    knex.on('query', onQuery)
    try {
      const resetting = account.passwordReset.reset({
        token: recoveryToken,
        password: 'resetPassword123',
      })
      void resetting.catch(() => {})
      await attemptedUserLock
      releaseProof()
      const results = await Promise.allSettled([changing, resetting])
      assert.lengthOf(
        results.filter((item) => item.status === 'fulfilled'),
        1
      )
      assert.equal(results[0].status, 'fulfilled')
      assert.equal(results[1].status, 'rejected')
      if (results[1].status === 'rejected') assert.instanceOf(results[1].reason, InvalidTokenError)
      assert.equal(callbackCalls, 1)
      const row = await kit.db.from('users').where('id', user.id).first()
      const changed = await kit.hash.verify(row.password, 'changedPassword123')
      const reset = await kit.hash.verify(row.password, 'resetPassword123')
      assert.notEqual(changed, reset)
      assert.isTrue(changed || reset)
      assert.lengthOf(await kit.db.from('password_reset_tokens'), 0)
    } finally {
      releaseProof()
      knex.off('query', onQuery)
      await changing.catch(() => {})
    }
  }).timeout(8000)
})
