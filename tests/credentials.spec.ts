import { DateTime } from 'luxon'
import { test } from '@japa/runner'
import type { AccountKit } from '../src/account_kit.js'
import {
  DeliveryError,
  EmailAlreadyRegisteredError,
  IdentityNotConfirmedError,
  InvalidInputError,
  InvalidTokenError,
  NoPasswordError,
  PostCommitError,
  ThrottledError,
} from '../src/errors.js'
import { generateToken, hashToken } from '../src/tokens.js'
import type { AccountKitConfig, AccountUser } from '../src/types.js'
import { useTestApp } from './helpers/app.js'
import {
  insertUser,
  makeConfig,
  makeNotify,
  makeService,
  makeUsersAdapter,
  tokenFrom,
} from './helpers/fakes.js'
test.group('credentials', (group) => {
  const kit = useTestApp(group)

  const createUser = (social = false) =>
    insertUser(kit, social ? { password: null, verified: false } : { password: 'oldPassword123' })

  const service = (overrides: Partial<AccountKitConfig> = {}) =>
    makeService(kit, { minRequestMs: 0, ...overrides }).account

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

  async function issueEmailChange(
    account: AccountKit,
    user: AccountUser,
    recorder: ReturnType<typeof makeNotify>,
    newEmail = 'new@example.test'
  ) {
    await account.credentials.requestEmailChange({
      actorId: user.id,
      currentPassword: 'oldPassword123',
      newEmail,
    })
    const call = recorder.calls.at(-1)!
    assertEmailChangeCall(call, user, newEmail)
    return tokenFrom(call.args[2])
  }

  function assertEmailChangeCall(
    call: ReturnType<typeof makeNotify>['calls'][number],
    user: AccountUser,
    email: string
  ) {
    if (
      call.method !== 'emailChangeConfirm' ||
      (call.args[0] as AccountUser).id !== user.id ||
      call.args[1] !== email
    )
      throw new Error('Unexpected email-change notification')
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

  test('a password change and independent recovery reset serialize without a database error', async ({
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
    const changing = account.credentials.changePassword({
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
      if (/select .*users.*for update|update ["`]?users["`]? set id = id/i.test(query.sql))
        attempted()
    }
    knex.on('query', onQuery)
    try {
      const resetting = account.recovery.reset({
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
      assert.lengthOf(await kit.db.from('account_recovery_tokens'), 0)
    } finally {
      releaseProof()
      knex.off('query', onQuery)
      await changing.catch(() => {})
    }
  }).timeout(8000)

  test('requests a bound email-change token and completes the change', async ({ assert }) => {
    const user = await createUser()
    const recorder = makeNotify()
    const account = service({ notify: recorder.notify })
    await account.credentials.requestEmailChange({
      actorId: user.id,
      currentPassword: 'oldPassword123',
      newEmail: ' NEW@EXAMPLE.TEST ',
    })
    const row = await kit.db.from('account_email_changes').first()
    assert.equal(row.current_email, user.email)
    assert.equal(row.new_email, 'new@example.test')
    const token = tokenFrom(recorder.calls[0].args[2])
    assert.equal(row.token_hash, hashToken(token))
    const changed = await account.credentials.completeEmailChange({ token })
    assert.equal(changed.email, 'new@example.test')
    assert.isNotNull(changed.emailVerifiedAt)
  })

  test('request validates raw email before throttle and rejects missing or wrong proof', async ({
    assert,
  }) => {
    const user = await createUser()
    const account = service()
    for (const newEmail of [null, 'a@', 'a@@b', 'x'.repeat(255)])
      await assert.rejects(
        () =>
          account.credentials.requestEmailChange({
            actorId: user.id,
            currentPassword: 'oldPassword123',
            newEmail: newEmail as never,
          }),
        InvalidInputError
      )
    for (const currentPassword of [undefined, '', 'incorrect'])
      await assert.rejects(
        () =>
          account.credentials.requestEmailChange({
            actorId: user.id,
            currentPassword: currentPassword as never,
            newEmail: 'new@example.test',
          }),
        IdentityNotConfirmedError
      )
    await assert.rejects(
      () =>
        account.credentials.requestEmailChange({
          actorId: 99999,
          currentPassword: 'oldPassword123',
          newEmail: 'new@example.test',
        }),
      InvalidInputError
    )
    assert.lengthOf(await kit.db.from('account_email_changes'), 0)
  })

  test('request rejects social-only accounts and already registered target email', async ({
    assert,
  }) => {
    const social = await createUser(true)
    const account = service()
    await assert.rejects(
      () =>
        account.credentials.requestEmailChange({
          actorId: social.id,
          currentPassword: 'anything',
          newEmail: 'new@example.test',
        }),
      NoPasswordError
    )
    await kit.db
      .table('users')
      .insert({ email: 'new@example.test', created_at: DateTime.utc().toISO() })
    const users = makeUsersAdapter(kit.db, kit.hash)
    await kit.db
      .from('users')
      .where('id', social.id)
      .update({ password: await kit.hash.make('oldPassword123') })
    const actor = await users.findById(social.id)
    await assert.rejects(
      () =>
        account.credentials.requestEmailChange({
          actorId: actor!.id,
          currentPassword: 'oldPassword123',
          newEmail: 'new@example.test',
        }),
      EmailAlreadyRegisteredError
    )
    assert.lengthOf(await kit.db.from('account_email_changes'), 0)
  })

  test('same normalized email is a proved no-op without row or delivery', async ({ assert }) => {
    const user = await createUser()
    const recorder = makeNotify()
    const account = service({ notify: recorder.notify })
    await assert.rejects(
      () =>
        account.credentials.requestEmailChange({
          actorId: user.id,
          currentPassword: 'wrong',
          newEmail: ' PERSON@EXAMPLE.TEST ',
        }),
      IdentityNotConfirmedError
    )
    assert.isUndefined(
      await account.credentials.requestEmailChange({
        actorId: user.id,
        currentPassword: 'oldPassword123',
        newEmail: ' PERSON@EXAMPLE.TEST ',
      })
    )
    assert.lengthOf(recorder.calls, 0)
    assert.lengthOf(await kit.db.from('account_email_changes'), 0)
    for (let index = 0; index < 3; index++)
      await account.credentials.requestEmailChange({
        actorId: user.id,
        currentPassword: 'oldPassword123',
        newEmail: user.email,
      })
    await assert.rejects(
      () =>
        account.credentials.requestEmailChange({
          actorId: user.id,
          currentPassword: 'oldPassword123',
          newEmail: user.email,
        }),
      ThrottledError
    )
  })

  test('request and password change share the identity throttle before lookup or proof', async ({
    assert,
  }) => {
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
      await account.credentials.requestEmailChange({
        actorId: user.id,
        currentPassword: 'oldPassword123',
        newEmail: 'new@example.test',
      })
      assert.fail('expected throttle')
    } catch (error) {
      assert.instanceOf(error, ThrottledError)
      assert.isAbove((error as ThrottledError).retryAfterSeconds, 0)
    }
    assert.equal(lookups, 5)
    assert.equal(proofs, 5)
    assert.lengthOf(await kit.db.from('account_email_changes'), 0)
  })

  test('request holds the actor lock through the password proof', async ({ assert }) => {
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
    const requesting = account.credentials.requestEmailChange({
      actorId: user.id,
      currentPassword: 'oldPassword123',
      newEmail: 'new@example.test',
    })
    try {
      await ready
      let conflict: unknown
      try {
        if (process.env.DB_CLIENT === 'pg') {
          await kit.db.transaction((trx) =>
            trx.rawQuery('SELECT id FROM users WHERE id = ? FOR UPDATE NOWAIT', [user.id]).exec()
          )
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
      await requesting.catch(() => {})
      if (native) await sqliteClient!.client.releaseConnection(native)
    }
  })

  test('request replaces every stored field and invalidates the previous link', async ({
    assert,
  }) => {
    const user = await createUser()
    const recorder = makeNotify()
    const account = service({ notify: recorder.notify })
    const first = await issueEmailChange(account, user, recorder)
    const before = await kit.db.from('account_email_changes').first()
    const stale = DateTime.utc().minus({ days: 2 }).toISO()
    await kit.db.from('account_email_changes').where('user_id', user.id).update({
      current_email: 'stale@example.test',
      expires_at: stale,
      created_at: stale,
    })
    const second = await issueEmailChange(account, user, recorder, 'other@example.test')
    const rows = await kit.db.from('account_email_changes')
    assert.lengthOf(rows, 1)
    assert.equal(rows[0].user_id, user.id)
    assert.equal(rows[0].current_email, user.email)
    assert.equal(rows[0].new_email, 'other@example.test')
    assert.equal(rows[0].token_hash, hashToken(second))
    assert.notEqual(rows[0].token_hash, before.token_hash)
    assert.notEqual(new Date(rows[0].created_at).valueOf(), new Date(stale).valueOf())
    assert.isNotNull(rows[0].created_at)
    assert.isAbove(new Date(rows[0].expires_at).valueOf(), new Date(rows[0].created_at).valueOf())
    assert.isFalse(Object.values(rows[0]).includes(second))
    await assert.rejects(
      () => account.credentials.completeEmailChange({ token: first }),
      InvalidTokenError
    )
    const changed = await account.credentials.completeEmailChange({ token: second })
    assert.equal(changed.email, 'other@example.test')
  })

  test('request delivery failure preserves the committed token and cause', async ({ assert }) => {
    const user = await createUser()
    const recorder = makeNotify()
    recorder.failOn('emailChangeConfirm')
    const account = service({ notify: recorder.notify })
    await assert.rejects(
      () =>
        account.credentials.requestEmailChange({
          actorId: user.id,
          currentPassword: 'oldPassword123',
          newEmail: 'new@example.test',
        }),
      DeliveryError
    )
    assert.lengthOf(await kit.db.from('account_email_changes'), 1)
    assert.lengthOf(recorder.calls, 1)
  })

  test('email-change URL callback failure preserves the committed token', async ({ assert }) => {
    const user = await createUser()
    const users = makeUsersAdapter(kit.db, kit.hash)
    const defaults = makeConfig({ users })
    const failure = new Error('url failed')
    const account = service({
      urls: {
        ...defaults.urls,
        emailChange: () => {
          throw failure
        },
      },
    })
    try {
      await account.credentials.requestEmailChange({
        actorId: user.id,
        currentPassword: 'oldPassword123',
        newEmail: 'new@example.test',
      })
      assert.fail('expected delivery error')
    } catch (error) {
      assert.instanceOf(error, DeliveryError)
      assert.equal((error as DeliveryError).cause, failure)
    }
    assert.lengthOf(await kit.db.from('account_email_changes'), 1)
  })

  test('complete invalidates recovery, reloads a verified user, and orders postcommit callbacks', async ({
    assert,
  }) => {
    const user = await createUser()
    await seedTokens(user)
    await kit.db.from('users').where('id', user.id).update({ email_verified_at: null })
    const recorder = makeNotify()
    const events: string[] = []
    const users = makeUsersAdapter(kit.db, kit.hash)
    const account = service({
      notify: {
        ...recorder.notify,
        async emailChanged(previous, changed) {
          events.push('notify')
          assert.equal(previous, user.email)
          assert.equal(changed.email, 'new@example.test')
          assert.lengthOf(await kit.db.from('account_email_changes'), 0)
          assert.lengthOf(await kit.db.from('account_recovery_tokens'), 0)
        },
      },
      onCredentialsChanged: async (changed) => {
        events.push('credentials')
        const stored = await users.findById(changed.id)
        assert.equal(stored?.email, changed.email)
        assert.isNotNull(changed.emailVerifiedAt)
      },
    })
    const token = await issueEmailChange(account, user, recorder)
    const changed = await account.credentials.completeEmailChange({ token })
    assert.equal(changed.email, 'new@example.test')
    assert.isNotNull(changed.emailVerifiedAt)
    assert.deepEqual(events, ['credentials', 'notify'])
    assert.lengthOf(await kit.db.from('account_recovery_tokens'), 0)
    await assert.rejects(
      () => account.credentials.completeEmailChange({ token }),
      InvalidTokenError
    )
  })

  test('complete rejects malformed, expired, deleted-user, and old-current-email tokens', async ({
    assert,
  }) => {
    const user = await createUser()
    const recorder = makeNotify()
    const account = service({ notify: recorder.notify })
    for (const token of [null, 123, '', 'bad'])
      await assert.rejects(
        () => account.credentials.completeEmailChange({ token: token as never }),
        InvalidTokenError
      )
    const token = await issueEmailChange(account, user, recorder)
    await kit.db
      .from('account_email_changes')
      .where('user_id', user.id)
      .update({ expires_at: DateTime.utc().minus({ second: 1 }).toISO() })
    await assert.rejects(
      () => account.credentials.completeEmailChange({ token }),
      InvalidTokenError
    )
    assert.lengthOf(await kit.db.from('account_email_changes'), 1)
    const second = await issueEmailChange(account, user, recorder)
    await kit.db.from('users').where('id', user.id).update({ email: 'changed@example.test' })
    await assert.rejects(
      () => account.credentials.completeEmailChange({ token: second }),
      InvalidTokenError
    )
    assert.lengthOf(await kit.db.from('account_email_changes'), 1)
    const third = await issueEmailChange(
      account,
      { ...user, email: 'changed@example.test' },
      recorder
    )
    await kit.db.from('users').where('id', user.id).delete()
    await assert.rejects(
      () => account.credentials.completeEmailChange({ token: third }),
      InvalidTokenError
    )
  })

  test('complete rejects a target registered after request and restores the token', async ({
    assert,
  }) => {
    const user = await createUser()
    const recorder = makeNotify()
    const users = makeUsersAdapter(kit.db, kit.hash)
    let setEmailCalls = 0
    const account = service({
      notify: recorder.notify,
      users: {
        ...users,
        async setEmail(...args) {
          setEmailCalls++
          return users.setEmail(...args)
        },
      },
    })
    const token = await issueEmailChange(account, user, recorder)
    await kit.db
      .table('users')
      .insert({ email: 'new@example.test', created_at: DateTime.utc().toISO() })
    await assert.rejects(
      () => account.credentials.completeEmailChange({ token }),
      EmailAlreadyRegisteredError
    )
    const stored = await kit.db.from('users').where('id', user.id).first()
    assert.equal(stored.email, user.email)
    assert.lengthOf(await kit.db.from('account_email_changes'), 1)
    assert.equal(setEmailCalls, 0)
  })

  test('a registration at setEmail maps the real unique violation after rollback', async ({
    assert,
  }) => {
    const user = await createUser()
    const recorder = makeNotify()
    const users = makeUsersAdapter(kit.db, kit.hash)
    const account = service({
      notify: recorder.notify,
      users: {
        ...users,
        async setEmail(id, email, trx) {
          await trx.table('users').insert({ email, created_at: DateTime.utc().toISO() })
          await users.setEmail(id, email, trx)
        },
      },
    })
    const token = await issueEmailChange(account, user, recorder)
    await assert.rejects(
      () => account.credentials.completeEmailChange({ token }),
      EmailAlreadyRegisteredError
    )
    const stored = await kit.db.from('users').where('id', user.id).first()
    assert.equal(stored.email, user.email)
    assert.lengthOf(await kit.db.from('users'), 1)
    assert.lengthOf(await kit.db.from('account_email_changes'), 1)
  })

  test('password change invalidates an email-change link', async ({ assert }) => {
    const user = await createUser()
    const recorder = makeNotify()
    const account = service({ notify: recorder.notify })
    const token = await issueEmailChange(account, user, recorder)
    await account.credentials.changePassword({
      actorId: user.id,
      currentPassword: 'oldPassword123',
      newPassword: 'newPassword123',
    })
    await assert.rejects(
      () => account.credentials.completeEmailChange({ token }),
      InvalidTokenError
    )
  })

  test('two independent completions consume one token only once', async ({ assert }) => {
    const user = await createUser()
    const recorder = makeNotify()
    const account = service({ notify: recorder.notify })
    const token = await issueEmailChange(account, user, recorder)
    const results = await Promise.allSettled([
      account.credentials.completeEmailChange({ token }),
      account.credentials.completeEmailChange({ token }),
    ])
    assert.lengthOf(
      results.filter((result) => result.status === 'fulfilled'),
      1
    )
    assert.lengthOf(
      results.filter(
        (result) => result.status === 'rejected' && result.reason instanceof InvalidTokenError
      ),
      1
    )
    const stored = await kit.db.from('users').where('id', user.id).first()
    assert.equal(stored.email, 'new@example.test')
  })

  test('adapter write then throw rolls back the email and consumed token', async ({ assert }) => {
    const user = await createUser()
    const recorder = makeNotify()
    const users = makeUsersAdapter(kit.db, kit.hash)
    const account = service({
      notify: recorder.notify,
      users: {
        ...users,
        async setEmail(...args) {
          await users.setEmail(...args)
          throw new Error('setEmail failed')
        },
      },
    })
    const token = await issueEmailChange(account, user, recorder)
    await assert.rejects(
      () => account.credentials.completeEmailChange({ token }),
      'setEmail failed'
    )
    const stored = await kit.db.from('users').where('id', user.id).first()
    assert.equal(stored.email, user.email)
    assert.lengthOf(await kit.db.from('account_email_changes'), 1)
  })

  test('emailChanged failure reports cause after the new email committed', async ({ assert }) => {
    const user = await createUser()
    const recorder = makeNotify()
    const failure = new Error('emailChanged failed')
    let credentialsCalls = 0
    const account = service({
      notify: {
        ...recorder.notify,
        async emailChanged() {
          throw failure
        },
      },
      onCredentialsChanged: async () => {
        credentialsCalls++
      },
    })
    const token = await issueEmailChange(account, user, recorder)
    try {
      await account.credentials.completeEmailChange({ token })
      assert.fail('expected postcommit error')
    } catch (error) {
      assert.instanceOf(error, PostCommitError)
      assert.equal((error as PostCommitError).cause, failure)
    }
    assert.equal(credentialsCalls, 1)
    const stored = await kit.db.from('users').where('id', user.id).first()
    assert.equal(stored.email, 'new@example.test')
    assert.lengthOf(await kit.db.from('account_email_changes'), 0)
  })

  test('onCredentialsChanged failure still notifies the previous email and preserves the committed change', async ({
    assert,
  }) => {
    const user = await createUser()
    const recorder = makeNotify()
    const failure = new Error('credentials callback failed')
    const account = service({
      notify: recorder.notify,
      onCredentialsChanged: async () => {
        throw failure
      },
    })
    const token = await issueEmailChange(account, user, recorder)
    try {
      await account.credentials.completeEmailChange({ token })
      assert.fail('expected postcommit error')
    } catch (error) {
      assert.instanceOf(error, PostCommitError)
      assert.equal((error as PostCommitError).cause, failure)
    }
    const notice = recorder.calls.find((call) => call.method === 'emailChanged')
    assert.isDefined(notice)
    assert.equal(notice!.args[0], 'person@example.test')
    const stored = await kit.db.from('users').where('id', user.id).first()
    assert.equal(stored.email, 'new@example.test')
    assert.lengthOf(await kit.db.from('account_email_changes'), 0)
  })

  test('both post-commit failures are reported together in order', async ({ assert }) => {
    const user = await createUser()
    const recorder = makeNotify()
    const noticeFailure = new Error('notice failed')
    const callbackFailure = new Error('callback failed')
    const account = service({
      notify: {
        ...recorder.notify,
        async emailChanged() {
          throw noticeFailure
        },
      },
      onCredentialsChanged: async () => {
        throw callbackFailure
      },
    })
    const token = await issueEmailChange(account, user, recorder)
    try {
      await account.credentials.completeEmailChange({ token })
      assert.fail('expected postcommit error')
    } catch (error) {
      assert.instanceOf(error, PostCommitError)
      const cause = (error as PostCommitError).cause
      assert.instanceOf(cause, AggregateError)
      assert.deepEqual((cause as AggregateError).errors, [callbackFailure, noticeFailure])
    }
    const stored = await kit.db.from('users').where('id', user.id).first()
    assert.equal(stored.email, 'new@example.test')
  })
})
