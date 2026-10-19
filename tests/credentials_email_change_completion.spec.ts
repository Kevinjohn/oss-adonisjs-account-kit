import { DateTime } from 'luxon'
import { test } from '@japa/runner'
import { EmailAlreadyRegisteredError, InvalidTokenError, PostCommitError } from '../src/errors.js'
import { hashToken } from '../src/tokens.js'
import { useTestApp } from './helpers/app.js'
import { makeNotify, makeUsersAdapter, tokenFrom } from './helpers/fakes.js'
import { credentialsFixtures } from './helpers/credentials.js'
import { dbTime } from './helpers/db_time.js'
test.group('emailPasswordManagement', (group) => {
  const kit = useTestApp(group)
  const { createUser, service, seedTokens, issueEmailChange } = credentialsFixtures(kit)

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
