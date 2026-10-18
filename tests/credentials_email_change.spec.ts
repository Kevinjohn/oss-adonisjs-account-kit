import { DateTime } from 'luxon'
import { test } from '@japa/runner'
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
import { hashToken } from '../src/tokens.js'
import { useTestApp } from './helpers/app.js'
import {
  insertUser,
  makeConfig,
  makeNotify,
  makeService,
  makeUsersAdapter,
  tokenFrom,
} from './helpers/fakes.js'
import { credentialsFixtures } from './helpers/credentials.js'
import { locksRows, lockNotAvailableCode } from './helpers/dialect.js'
import { dbTime } from './helpers/db_time.js'
test.group('emailPasswordManagement', (group) => {
  const kit = useTestApp(group)
  const { createUser, service, seedTokens, issueEmailChange } = credentialsFixtures(kit)

  test('requests a bound email-change token and completes the change', async ({ assert }) => {
    const user = await createUser()
    const recorder = makeNotify()
    const account = service({ notify: recorder.notify })
    await account.emailPasswordManagement.requestEmailChange({
      actorId: user.id,
      currentPassword: 'oldPassword123',
      newEmail: ' NEW@EXAMPLE.TEST ',
    })
    const row = await kit.db.from('email_verification_tokens').first()
    assert.equal(row.email, 'new@example.test')
    const token = tokenFrom(recorder.calls[0].args[2])
    assert.equal(row.hash, hashToken(token))
    const changed = await account.emailPasswordManagement.completeEmailChange({ token })
    assert.equal(changed.email, 'new@example.test')
    assert.isNotNull(changed.emailVerifiedAt)
  })

  test('email-change inspection preserves proof and resend suppresses within a minute', async ({
    assert,
  }) => {
    const user = await createUser()
    const recorder = makeNotify()
    const account = service({ notify: recorder.notify })
    const request = () =>
      account.emailPasswordManagement.requestEmailChange({
        actorId: user.id,
        currentPassword: 'oldPassword123',
        newEmail: 'new@example.test',
      })
    await request()
    const token = tokenFrom(recorder.calls[0].args[2])
    assert.isTrue(await account.emailPasswordManagement.inspectEmailChange({ token }))
    await request()
    assert.lengthOf(recorder.calls, 1)
    assert.isTrue(await account.emailPasswordManagement.inspectEmailChange({ token }))
    await kit.db
      .from('email_verification_tokens')
      .where('tokenable_id', user.id)
      .update({
        created_at: dbTime(kit, DateTime.utc().minus({ minutes: 2 })),
      })
    await request()
    assert.lengthOf(recorder.calls, 2)
    assert.isFalse(await account.emailPasswordManagement.inspectEmailChange({ token }))
    assert.isTrue(
      await account.emailPasswordManagement.inspectEmailChange({
        token: tokenFrom(recorder.calls[1].args[2]),
      })
    )
  })

  test('an expired pending-address proof can be reissued inside one minute', async ({ assert }) => {
    const user = await createUser()
    const recorder = makeNotify()
    const account = service({ notify: recorder.notify, expiresIn: { emailChange: 1 } })
    const request = () =>
      account.emailPasswordManagement.requestEmailChange({
        actorId: user.id,
        currentPassword: 'oldPassword123',
        newEmail: 'new@example.test',
      })
    await request()
    const token = tokenFrom(recorder.calls[0].args[2])
    await kit.db
      .from('email_verification_tokens')
      .where('tokenable_id', user.id)
      .update({
        expires_at: dbTime(kit, DateTime.utc().minus({ seconds: 1 })),
      })
    await request()
    assert.lengthOf(recorder.calls, 2)
    assert.isFalse(await account.emailPasswordManagement.inspectEmailChange({ token }))
    assert.isTrue(
      await account.emailPasswordManagement.inspectEmailChange({
        token: tokenFrom(recorder.calls[1].args[2]),
      })
    )
  })

  test('requesting the confirmed address cancels the pending change and its proof', async ({
    assert,
  }) => {
    const user = await createUser()
    const recorder = makeNotify()
    const account = service({ notify: recorder.notify })
    await account.emailPasswordManagement.requestEmailChange({
      actorId: user.id,
      currentPassword: 'oldPassword123',
      newEmail: 'new@example.test',
    })
    const token = tokenFrom(recorder.calls[0].args[2])
    await account.emailPasswordManagement.requestEmailChange({
      actorId: user.id,
      currentPassword: 'oldPassword123',
      newEmail: user.email,
    })
    assert.lengthOf(recorder.calls, 1)
    assert.isFalse(await account.emailPasswordManagement.inspectEmailChange({ token }))
    const row = await kit.db.from('users').where('id', user.id).first()
    assert.isNull(row.unverified_email)
  })

  test('email-change inspection rejects proof when pending account state differs', async ({
    assert,
  }) => {
    const user = await createUser()
    const recorder = makeNotify()
    const account = service({ notify: recorder.notify })
    await account.emailPasswordManagement.requestEmailChange({
      actorId: user.id,
      currentPassword: 'oldPassword123',
      newEmail: 'new@example.test',
    })
    const token = tokenFrom(recorder.calls[0].args[2])
    await kit.db.from('users').where('id', user.id).update({
      unverified_email: 'other@example.test',
    })
    assert.isFalse(await account.emailPasswordManagement.inspectEmailChange({ token }))
  })

  test('inactive address replacement requires activation and a fresh password', async ({
    assert,
  }) => {
    const user = await insertUser(kit, { password: 'oldPassword123', verified: false })
    const recorder = makeNotify()
    const account = service({ notify: recorder.notify })
    await account.emailPasswordManagement.requestEmailChange({
      actorId: user.id,
      currentPassword: 'oldPassword123',
      newEmail: 'new@example.test',
    })
    const row = await kit.db.from('users').where('id', user.id).first()
    assert.equal(row.email, 'new@example.test')
    assert.equal(row.unverified_email, 'new@example.test')
    assert.equal(recorder.calls[0].method, 'accountActivationProvision')
    const token = tokenFrom(recorder.calls[0].args[1])
    await assert.rejects(
      () => account.emailPasswordManagement.completeEmailChange({ token }),
      InvalidTokenError
    )
    const { account: verification } = makeService(kit, { notify: recorder.notify })
    assert.equal(
      await verification.emailVerification.complete({ token, password: 'freshPassword123' }),
      'verified'
    )
    const active = await kit.db.from('users').where('id', user.id).first()
    assert.isNull(active.unverified_email)
  })

  test('request validates raw email before throttle and rejects missing or wrong proof', async ({
    assert,
  }) => {
    const user = await createUser()
    const recorder = makeNotify()
    const account = service({ notify: recorder.notify })
    for (const newEmail of [
      null,
      'a@',
      'a@@b',
      '@ab',
      'ab@',
      '  @  ',
      'a b@example.test',
      'x'.repeat(255),
    ])
      await assert.rejects(
        () =>
          account.emailPasswordManagement.requestEmailChange({
            actorId: user.id,
            currentPassword: 'oldPassword123',
            newEmail: newEmail as never,
          }),
        InvalidInputError
      )
    assert.lengthOf(await kit.db.from('email_verification_tokens'), 0)
    assert.lengthOf(recorder.calls, 0)
    for (const currentPassword of [undefined, '', 'incorrect'])
      await assert.rejects(
        () =>
          account.emailPasswordManagement.requestEmailChange({
            actorId: user.id,
            currentPassword: currentPassword as never,
            newEmail: 'new@example.test',
          }),
        IdentityNotConfirmedError
      )
    await assert.rejects(
      () =>
        account.emailPasswordManagement.requestEmailChange({
          actorId: 99999,
          currentPassword: 'oldPassword123',
          newEmail: 'new@example.test',
        }),
      InvalidInputError
    )
    assert.lengthOf(await kit.db.from('email_verification_tokens'), 0)
  })

  test('request rejects social-only accounts and already registered target email', async ({
    assert,
  }) => {
    const social = await createUser(true)
    const account = service()
    await assert.rejects(
      () =>
        account.emailPasswordManagement.requestEmailChange({
          actorId: social.id,
          currentPassword: 'anything',
          newEmail: 'new@example.test',
        }),
      NoPasswordError
    )
    await kit.db
      .table('users')
      .insert({ email: 'new@example.test', created_at: dbTime(kit, DateTime.utc()) })
    const users = makeUsersAdapter(kit.db, kit.hash)
    await kit.db
      .from('users')
      .where('id', social.id)
      .update({ password: await kit.hash.make('oldPassword123') })
    const actor = await users.findById(social.id)
    await assert.rejects(
      () =>
        account.emailPasswordManagement.requestEmailChange({
          actorId: actor!.id,
          currentPassword: 'oldPassword123',
          newEmail: 'new@example.test',
        }),
      EmailAlreadyRegisteredError
    )
    assert.lengthOf(await kit.db.from('email_verification_tokens'), 0)
  })

  test('same normalized email is a proved no-op without row or delivery', async ({ assert }) => {
    const user = await createUser()
    const recorder = makeNotify()
    const account = service({ notify: recorder.notify })
    await assert.rejects(
      () =>
        account.emailPasswordManagement.requestEmailChange({
          actorId: user.id,
          currentPassword: 'wrong',
          newEmail: ' PERSON@EXAMPLE.TEST ',
        }),
      IdentityNotConfirmedError
    )
    assert.isUndefined(
      await account.emailPasswordManagement.requestEmailChange({
        actorId: user.id,
        currentPassword: 'oldPassword123',
        newEmail: ' PERSON@EXAMPLE.TEST ',
      })
    )
    assert.lengthOf(recorder.calls, 0)
    assert.lengthOf(await kit.db.from('email_verification_tokens'), 0)
    for (let index = 0; index < 3; index++)
      await account.emailPasswordManagement.requestEmailChange({
        actorId: user.id,
        currentPassword: 'oldPassword123',
        newEmail: user.email,
      })
    await assert.rejects(
      () =>
        account.emailPasswordManagement.requestEmailChange({
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
          account.emailPasswordManagement.changePassword({
            actorId: user.id,
            currentPassword: 'wrong',
            newPassword: 'newPassword123',
          }),
        IdentityNotConfirmedError
      )
    try {
      await account.emailPasswordManagement.requestEmailChange({
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
    assert.lengthOf(await kit.db.from('email_verification_tokens'), 0)
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
    const sqliteClient = locksRows ? null : kit.db.connection().getWriteClient()
    const native = sqliteClient
      ? ((await sqliteClient.client.acquireConnection()) as {
          pragma: (statement: string, options: { simple: true }) => number | string
          prepare: (statement: string) => { run: (id: string | number) => void }
        })
      : null
    if (native) assert.equal(native.pragma('journal_mode', { simple: true }), 'wal')
    const requesting = account.emailPasswordManagement.requestEmailChange({
      actorId: user.id,
      currentPassword: 'oldPassword123',
      newEmail: 'new@example.test',
    })
    try {
      await ready
      let conflict: unknown
      try {
        if (locksRows) {
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
      assert.equal((conflict as { code?: string } | undefined)?.code, lockNotAvailableCode)
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
    const before = await kit.db.from('email_verification_tokens').first()
    const stale = dbTime(kit, DateTime.utc().minus({ days: 2 }))
    await kit.db.from('email_verification_tokens').where('tokenable_id', user.id).update({
      email: 'stale@example.test',
      expires_at: stale,
      created_at: stale,
    })
    const second = await issueEmailChange(account, user, recorder, 'other@example.test')
    const rows = await kit.db.from('email_verification_tokens')
    assert.lengthOf(rows, 1)
    assert.equal(rows[0].tokenable_id, user.id)
    assert.equal(rows[0].email, 'other@example.test')
    assert.equal(rows[0].hash, hashToken(second))
    assert.notEqual(rows[0].hash, before.hash)
    assert.notEqual(new Date(rows[0].created_at).valueOf(), new Date(stale).valueOf())
    assert.isNotNull(rows[0].created_at)
    assert.isAbove(new Date(rows[0].expires_at).valueOf(), new Date(rows[0].created_at).valueOf())
    assert.isFalse(Object.values(rows[0]).includes(second))
    await assert.rejects(
      () => account.emailPasswordManagement.completeEmailChange({ token: first }),
      InvalidTokenError
    )
    const changed = await account.emailPasswordManagement.completeEmailChange({ token: second })
    assert.equal(changed.email, 'other@example.test')
  })

  test('request delivery failure preserves the committed token and cause', async ({ assert }) => {
    const user = await createUser()
    const recorder = makeNotify()
    recorder.failOn('emailChangeProvision')
    const account = service({ notify: recorder.notify })
    await assert.rejects(
      () =>
        account.emailPasswordManagement.requestEmailChange({
          actorId: user.id,
          currentPassword: 'oldPassword123',
          newEmail: 'new@example.test',
        }),
      DeliveryError
    )
    assert.lengthOf(await kit.db.from('email_verification_tokens'), 1)
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
      await account.emailPasswordManagement.requestEmailChange({
        actorId: user.id,
        currentPassword: 'oldPassword123',
        newEmail: 'new@example.test',
      })
      assert.fail('expected delivery error')
    } catch (error) {
      assert.instanceOf(error, DeliveryError)
      assert.equal((error as DeliveryError).cause, failure)
    }
    assert.lengthOf(await kit.db.from('email_verification_tokens'), 1)
  })

  test('complete invalidates password reset tokens, reloads a verified user, and orders postcommit callbacks', async ({
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
          assert.lengthOf(await kit.db.from('email_verification_tokens'), 0)
          assert.lengthOf(await kit.db.from('password_reset_tokens'), 0)
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
    const changed = await account.emailPasswordManagement.completeEmailChange({ token })
    assert.equal(changed.email, 'new@example.test')
    assert.isNotNull(changed.emailVerifiedAt)
    assert.deepEqual(events, ['credentials', 'notify'])
    assert.lengthOf(await kit.db.from('password_reset_tokens'), 0)
    await assert.rejects(
      () => account.emailPasswordManagement.completeEmailChange({ token }),
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
        () => account.emailPasswordManagement.completeEmailChange({ token: token as never }),
        InvalidTokenError
      )
    const token = await issueEmailChange(account, user, recorder)
    await kit.db
      .from('email_verification_tokens')
      .where('tokenable_id', user.id)
      .update({ expires_at: dbTime(kit, DateTime.utc().minus({ second: 1 })) })
    await assert.rejects(
      () => account.emailPasswordManagement.completeEmailChange({ token }),
      InvalidTokenError
    )
    assert.lengthOf(await kit.db.from('email_verification_tokens'), 1)
    const second = await issueEmailChange(account, user, recorder)
    await kit.db.from('users').where('id', user.id).update({ email: 'changed@example.test' })
    await assert.rejects(
      () => account.emailPasswordManagement.completeEmailChange({ token: second }),
      InvalidTokenError
    )
    assert.lengthOf(await kit.db.from('email_verification_tokens'), 1)
    const third = await issueEmailChange(
      account,
      { ...user, email: 'changed@example.test' },
      recorder
    )
    await kit.db.from('users').where('id', user.id).delete()
    await assert.rejects(
      () => account.emailPasswordManagement.completeEmailChange({ token: third }),
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
      .insert({ email: 'new@example.test', created_at: dbTime(kit, DateTime.utc()) })
    await assert.rejects(
      () => account.emailPasswordManagement.completeEmailChange({ token }),
      EmailAlreadyRegisteredError
    )
    const stored = await kit.db.from('users').where('id', user.id).first()
    assert.equal(stored.email, user.email)
    assert.lengthOf(await kit.db.from('email_verification_tokens'), 1)
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
          await trx.table('users').insert({ email, created_at: dbTime(kit, DateTime.utc()) })
          await users.setEmail(id, email, trx)
        },
      },
    })
    const token = await issueEmailChange(account, user, recorder)
    await assert.rejects(
      () => account.emailPasswordManagement.completeEmailChange({ token }),
      EmailAlreadyRegisteredError
    )
    const stored = await kit.db.from('users').where('id', user.id).first()
    assert.equal(stored.email, user.email)
    assert.lengthOf(await kit.db.from('users'), 1)
    assert.lengthOf(await kit.db.from('email_verification_tokens'), 1)
  })

  test('password change invalidates an email-change link', async ({ assert }) => {
    const user = await createUser()
    const recorder = makeNotify()
    const account = service({ notify: recorder.notify })
    const token = await issueEmailChange(account, user, recorder)
    await account.emailPasswordManagement.changePassword({
      actorId: user.id,
      currentPassword: 'oldPassword123',
      newPassword: 'newPassword123',
    })
    await assert.rejects(
      () => account.emailPasswordManagement.completeEmailChange({ token }),
      InvalidTokenError
    )
  })

  test('two independent completions consume one token only once', async ({ assert }) => {
    const user = await createUser()
    const recorder = makeNotify()
    const account = service({ notify: recorder.notify })
    const token = await issueEmailChange(account, user, recorder)
    const results = await Promise.allSettled([
      account.emailPasswordManagement.completeEmailChange({ token }),
      account.emailPasswordManagement.completeEmailChange({ token }),
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
      () => account.emailPasswordManagement.completeEmailChange({ token }),
      'setEmail failed'
    )
    const stored = await kit.db.from('users').where('id', user.id).first()
    assert.equal(stored.email, user.email)
    assert.lengthOf(await kit.db.from('email_verification_tokens'), 1)
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
      await account.emailPasswordManagement.completeEmailChange({ token })
      assert.fail('expected postcommit error')
    } catch (error) {
      assert.instanceOf(error, PostCommitError)
      assert.equal((error as PostCommitError).cause, failure)
    }
    assert.equal(credentialsCalls, 1)
    const stored = await kit.db.from('users').where('id', user.id).first()
    assert.equal(stored.email, 'new@example.test')
    assert.lengthOf(await kit.db.from('email_verification_tokens'), 0)
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
      await account.emailPasswordManagement.completeEmailChange({ token })
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
    assert.lengthOf(await kit.db.from('email_verification_tokens'), 0)
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
      await account.emailPasswordManagement.completeEmailChange({ token })
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

  /** Register a failing commit listener from the next transactional `findByEmail` call. */
  function faultOnNextEmailLookup(failure: Error) {
    const users = makeUsersAdapter(kit.db, kit.hash)
    let armed = false
    return {
      arm: () => {
        armed = true
      },
      users: {
        ...users,
        findByEmail: async (...args: Parameters<typeof users.findByEmail>) => {
          const trx = args[1]
          if (armed && trx) {
            armed = false
            trx.on('commit', () => {
              throw failure
            })
          }
          return users.findByEmail(...args)
        },
      },
    }
  }

  test('runs all email-change completion follow-ups once after a committed cleanup fault', async ({
    assert,
  }) => {
    const user = await createUser()
    const recorder = makeNotify()
    const failure = new Error('listener failed after commit')
    const calls: string[] = []
    const seam = faultOnNextEmailLookup(failure)
    const account = service({
      users: seam.users,
      notify: {
        ...recorder.notify,
        emailChanged: async (previousEmail, changed) => {
          calls.push(`notice:${previousEmail}`)
          await recorder.notify.emailChanged(previousEmail, changed)
        },
      },
      onCredentialsChanged: async () => {
        calls.push('credentials')
      },
      onLifecycleEvent: async (event) => {
        calls.push(event.type)
      },
    })
    const token = await issueEmailChange(account, user, recorder)
    calls.length = 0
    seam.arm()
    try {
      await account.emailPasswordManagement.completeEmailChange({ token })
      assert.fail('expected committed failure')
    } catch (error) {
      assert.instanceOf(error, PostCommitError)
      assert.isTrue((error as PostCommitError).committed)
      assert.equal((error as PostCommitError).cause, failure)
    }
    assert.deepEqual(calls, ['credentials', 'notice:person@example.test', 'email_change.completed'])
    const stored = await kit.db.from('users').where('id', user.id).first()
    assert.equal(stored.email, 'new@example.test')
    assert.lengthOf(await kit.db.from('email_verification_tokens'), 0)
  })

  test('delivers the email-change link once after a committed cleanup fault', async ({
    assert,
  }) => {
    const user = await createUser()
    const recorder = makeNotify()
    const failure = new Error('listener failed after commit')
    const events: string[] = []
    const seam = faultOnNextEmailLookup(failure)
    const account = service({
      users: seam.users,
      notify: recorder.notify,
      onLifecycleEvent: async (event) => {
        events.push(event.type)
      },
    })
    seam.arm()
    try {
      await account.emailPasswordManagement.requestEmailChange({
        actorId: user.id,
        currentPassword: 'oldPassword123',
        newEmail: 'new@example.test',
      })
      assert.fail('expected committed failure')
    } catch (error) {
      assert.instanceOf(error, PostCommitError)
      assert.isTrue((error as PostCommitError).committed)
      assert.equal((error as PostCommitError).cause, failure)
    }
    assert.deepEqual(
      recorder.calls.map((call) => call.method),
      ['emailChangeProvision']
    )
    assert.deepEqual(events, ['email_change.requested'])
    const row = await kit.db
      .from('email_verification_tokens')
      .where('tokenable_id', user.id)
      .first()
    assert.equal(row.hash, hashToken(tokenFrom(recorder.calls[0].args[2])))
  })

  test('a follow-up failure after a committed cleanup fault reports both causes', async ({
    assert,
  }) => {
    const user = await createUser()
    const recorder = makeNotify()
    const failure = new Error('listener failed after commit')
    const observerFailure = new Error('observer failed')
    const seam = faultOnNextEmailLookup(failure)
    const account = service({
      users: seam.users,
      notify: recorder.notify,
      onLifecycleEvent: async () => {
        throw observerFailure
      },
    })
    seam.arm()
    try {
      await account.emailPasswordManagement.requestEmailChange({
        actorId: user.id,
        currentPassword: 'oldPassword123',
        newEmail: 'new@example.test',
      })
      assert.fail('expected committed failure')
    } catch (error) {
      assert.instanceOf(error, PostCommitError)
      assert.isTrue((error as PostCommitError).committed)
      const cause = (error as PostCommitError).cause
      assert.instanceOf(cause, AggregateError)
      assert.deepEqual((cause as AggregateError).errors, [failure, observerFailure])
    }
    assert.lengthOf(recorder.calls, 1)
    assert.lengthOf(await kit.db.from('email_verification_tokens'), 1)
  })
})
