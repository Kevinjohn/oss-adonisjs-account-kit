import { DateTime } from 'luxon'
import { test } from '@japa/runner'
import { AccountKit, defineConfig } from '../src/account_kit.js'
import {
  IdentityNotConfirmedError,
  InvalidInputError,
  NoPasswordError,
  PostCommitError,
  ThrottledError,
} from '../src/errors.js'
import { generateToken, hashToken } from '../src/tokens.js'
import type { AccountKitConfig, AccountUser } from '../src/types.js'
import { bootTestApp } from './helpers/app.js'
import { makeConfig, makeUsersAdapter } from './helpers/fakes.js'
import { resetSchema } from './helpers/schema.js'

test.group('credentials.changePassword', (group) => {
  let kit: Awaited<ReturnType<typeof bootTestApp>>
  group.setup(async () => {
    kit = await bootTestApp()
  })
  group.each.setup(async () => {
    await resetSchema(kit)
    await kit.limiter.clear()
  })
  group.teardown(async () => {
    await kit.close()
  })

  async function createUser(social = false): Promise<AccountUser> {
    const users = makeUsersAdapter(kit.db, kit.hash)
    if (!social)
      return kit.db.transaction((trx) =>
        users.create(
          {
            email: 'person@example.test',
            password: 'oldPassword123',
            emailVerifiedAt: DateTime.utc(),
          },
          trx
        )
      )
    const [id] = await kit.db
      .table('users')
      .insert({
        email: 'person@example.test',
        password: null,
        email_verified_at: null,
        created_at: DateTime.utc().toISO(),
      })
      .returning('id')
    return (await users.findById(typeof id === 'object' ? id.id : id))!
  }

  function service(overrides: Partial<AccountKitConfig> = {}) {
    const { users, ...rest } = overrides
    const config = defineConfig(
      makeConfig({ users: users ?? makeUsersAdapter(kit.db, kit.hash), minRequestMs: 0, ...rest })
    )
    return new AccountKit({ config, db: kit.db, limiter: kit.limiter, encryption: null as never })
  }

  async function seedTokens(user: AccountUser) {
    const now = DateTime.utc()
    const recoveryToken = generateToken()
    const emailToken = generateToken()
    await kit.db.table('account_recovery_tokens').insert({
      user_id: user.id,
      email: user.email,
      token_hash: hashToken(recoveryToken),
      expires_at: now.plus({ hours: 1 }).toISO(),
      created_at: now.toISO(),
    })
    await kit.db.table('account_email_changes').insert({
      user_id: user.id,
      current_email: user.email,
      new_email: 'next@example.test',
      token_hash: hashToken(emailToken),
      expires_at: now.plus({ hours: 1 }).toISO(),
      created_at: now.toISO(),
    })
    return recoveryToken
  }

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
    for (const value of [null, 'short', 'x'.repeat(256)])
      await assert.rejects(
        () =>
          account.credentials.changePassword({
            actorId: user.id,
            currentPassword: 'oldPassword123',
            newPassword: value as never,
          }),
        InvalidInputError
      )
    assert.equal(lookups, 0)
    assert.isUndefined(
      await account.credentials.changePassword({
        actorId: user.id,
        currentPassword: 'oldPassword123',
        newPassword: 'newPassword123',
      })
    )
  })

  test('missing actor and missing or wrong proof reject without changing a password', async ({
    assert,
  }) => {
    const user = await createUser()
    const account = service()
    await assert.rejects(
      () =>
        account.credentials.changePassword({
          actorId: 99999,
          currentPassword: 'oldPassword123',
          newPassword: 'newPassword123',
        }),
      InvalidInputError
    )
    for (const currentPassword of [undefined, '', 'incorrect'])
      await assert.rejects(
        () =>
          account.credentials.changePassword({
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
        account.credentials.changePassword({
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
          account.credentials.changePassword({
            actorId: user.id,
            currentPassword: 'wrong',
            newPassword: 'newPassword123',
          }),
        IdentityNotConfirmedError
      )
    try {
      await account.credentials.changePassword({
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
          await kit.db.from('account_recovery_tokens').where('user_id', changed.id),
          0
        )
        assert.lengthOf(await kit.db.from('account_email_changes').where('user_id', changed.id), 0)
      },
    })
    assert.isUndefined(
      await account.credentials.changePassword({
        actorId: user.id,
        currentPassword: 'oldPassword123',
        newPassword: 'newPassword123',
      })
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
      await account.credentials.changePassword({
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
    assert.lengthOf(await kit.db.from('account_recovery_tokens'), 0)
    assert.lengthOf(await kit.db.from('account_email_changes'), 0)
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
      await account.credentials.changePassword({
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
    assert.lengthOf(await kit.db.from('account_recovery_tokens'), 1)
    assert.lengthOf(await kit.db.from('account_email_changes'), 1)
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
    const sqliteClient =
      process.env.DB_CLIENT === 'pg' ? null : kit.db.connection().getWriteClient()
    const native = sqliteClient
      ? ((await sqliteClient.client.acquireConnection()) as {
          pragma: (statement: string, options: { simple: true }) => number | string
          prepare: (statement: string) => { run: (id: string | number) => void }
        })
      : null
    if (native) assert.equal(native.pragma('journal_mode', { simple: true }), 'wal')
    const changing = account.credentials.changePassword({
      actorId: user.id,
      currentPassword: 'oldPassword123',
      newPassword: 'newPassword123',
    })
    try {
      await ready
      let conflict: unknown
      try {
        if (process.env.DB_CLIENT === 'pg') {
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
      assert.equal(
        (conflict as { code?: string } | undefined)?.code,
        process.env.DB_CLIENT === 'pg' ? '55P03' : 'SQLITE_BUSY'
      )
    } finally {
      releaseProof()
      await changing.catch(() => {})
      if (native) await sqliteClient!.client.releaseConnection(native)
    }
  })

  test('a password change and independent recovery reset leave exactly one final password', async ({
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
    const changing = account.credentials.changePassword({
      actorId: user.id,
      currentPassword: 'oldPassword123',
      newPassword: 'changedPassword123',
    })
    await ready
    const knex = kit.db.connection().getWriteClient()
    let attempted!: () => void
    const attemptedDelete = new Promise<void>((resolve) => {
      attempted = resolve
    })
    const onQuery = (query: { sql: string }) => {
      if (/delete from account_recovery_tokens/i.test(query.sql)) attempted()
    }
    knex.on('query', onQuery)
    try {
      const resetting = account.recovery.reset({
        token: recoveryToken,
        password: 'resetPassword123',
      })
      void resetting.catch(() => {})
      await attemptedDelete
      releaseProof()
      const results = await Promise.allSettled([changing, resetting])
      assert.lengthOf(
        results.filter((item) => item.status === 'fulfilled'),
        1
      )
      const row = await kit.db.from('users').where('id', user.id).first()
      const changed = await kit.hash.verify(row.password, 'changedPassword123')
      const reset = await kit.hash.verify(row.password, 'resetPassword123')
      assert.notEqual(changed, reset)
      assert.isTrue(changed || reset)
      assert.lengthOf(await kit.db.from('account_recovery_tokens'), 0)
    } finally {
      releaseProof()
      knex.off('query', onQuery)
      await changing.catch(() => {})
    }
  }).timeout(8000)
})
