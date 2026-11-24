import { DateTime } from 'luxon'
import { test } from '@japa/runner'
import {
  E_ACCOUNT_KIT_EMAIL_ALREADY_REGISTERED,
  E_ACCOUNT_KIT_INVALID_INPUT,
  E_ACCOUNT_KIT_INVALID_TOKEN,
  E_ACCOUNT_KIT_POST_COMMIT,
} from '../src/errors.js'
import { transaction } from '../src/db.js'
import type { AccountUser } from '../src/types.js'
import { useTestApp } from './helpers/app.js'
import { invitationHelpers } from './helpers/invitations.js'
import { allowAll, makeUsersAdapter } from './helpers/fakes.js'
import {
  createBarrier,
  startWithBackendId,
  waitForDatabaseLockWait,
} from './helpers/lock_coordination.js'
import { makeService, tokenFrom } from './helpers/fakes.js'
import { clientChallenge, provider } from './helpers/social_identity.js'
import { locksRows, testEngine } from './helpers/dialect.js'
import { dbTime } from './helpers/db_time.js'

test.group('invitations.accept', (group) => {
  const kit = useTestApp(group)

  const { createActor, service, issue } = invitationHelpers(kit)

  test('applies the shared new-password policy before consuming an invitation', async ({
    assert,
  }) => {
    const actor = await createActor()
    const { account, recorder } = service({
      passwordPolicy: { mixedCase: true, numbers: true, minScore: 3 },
    })
    const { token } = await issue(account, recorder, actor.id)
    await assert.rejects(
      () => account.invitations.accept({ token, password: 'password123' }),
      E_ACCOUNT_KIT_INVALID_INPUT
    )
    assert.lengthOf(await kit.db.from('account_invitations'), 1)
    await account.invitations.accept({ token, password: 'LongerPassword12345' })
  })

  test('consumes the token, creates a verified hashed user, runs callback in transaction, and reloads', async ({
    assert,
  }) => {
    const actor = await createActor()
    let callbackCalls = 0
    let callbackRole: string | undefined
    let callbackUser: AccountUser | undefined
    let canInvite = true
    const { account, recorder } = service({
      authorize: { ...allowAll, invite: async () => canInvite },
      onInvitationAccepted: async (user, invitation, trx) => {
        callbackCalls++
        callbackRole = invitation.role
        callbackUser = user
        const row = await trx.from('users').where('id', user.id).first()
        assert.equal(row.email, 'person@example.test')
        assert.equal(
          user.emailVerifiedAt?.toISO(),
          DateTime.fromJSDate(new Date(row.email_verified_at)).toUTC().toISO()
        )
        assert.isNull(user.unverifiedEmail)
        await trx
          .from('users')
          .where('id', user.id)
          .update({ email_verified_at: dbTime(kit, DateTime.utc().plus({ days: 1 })) })
      },
    })
    const { invitation, token } = await issue(account, recorder, actor.id)
    canInvite = false
    const accepted = await account.invitations.accept({ token, password: 'newPassword123' })
    assert.equal(callbackCalls, 1)
    assert.equal(callbackRole, 'admin')
    assert.equal(callbackUser?.id, accepted.id)
    assert.equal(accepted.email, invitation.email)
    assert.isTrue(accepted.hasPassword)
    assert.isNotNull(accepted.emailVerifiedAt)
    const stored = await kit.db.from('users').where('id', accepted.id).first()
    assert.equal(
      accepted.emailVerifiedAt?.toISO(),
      DateTime.fromJSDate(new Date(stored.email_verified_at)).toUTC().toISO()
    )
    assert.notEqual(accepted.emailVerifiedAt?.toISO(), callbackUser?.emailVerifiedAt?.toISO())
    assert.isNull(callbackUser?.unverifiedEmail)
    assert.notEqual(stored.password, 'newPassword123')
    assert.isTrue(await kit.hash.verify(stored.password, 'newPassword123'))
    assert.lengthOf(await kit.db.from('account_invitations'), 0)
  })

  test('emits the accepted event once after a committed cleanup fault', async ({ assert }) => {
    const actor = await createActor()
    const failure = new Error('listener failed after commit')
    const events: string[] = []
    let armed = false
    const { account, recorder } = service({
      onInvitationAccepted: async (_user, _invitation, trx) => {
        if (!armed) return
        trx.on('commit', () => {
          throw failure
        })
      },
      onLifecycleEvent: async (event) => {
        events.push(event.type)
      },
    })
    const { token } = await issue(account, recorder, actor.id)
    events.length = 0
    armed = true
    try {
      await account.invitations.accept({ token, password: 'newPassword123' })
      assert.fail('expected committed failure')
    } catch (error) {
      assert.instanceOf(error, E_ACCOUNT_KIT_POST_COMMIT)
      assert.isTrue((error as InstanceType<typeof E_ACCOUNT_KIT_POST_COMMIT>).committed)
      assert.equal((error as InstanceType<typeof E_ACCOUNT_KIT_POST_COMMIT>).cause, failure)
    }
    assert.deepEqual(events, ['invitation.accepted'])
    assert.isNotNull(await kit.db.from('users').where('email', 'person@example.test').first())
    assert.lengthOf(await kit.db.from('account_invitations'), 0)
  })

  test('invalid password precedes token shape; malformed, unknown, expired, revoked and reused tokens reject', async ({
    assert,
  }) => {
    const actor = await createActor()
    const { account, recorder } = service()
    const { invitation, token } = await issue(account, recorder, actor.id)
    for (const password of [null, 'short', 'x'.repeat(257)])
      await assert.rejects(
        () => account.invitations.accept({ token: 'bad', password: password as never }),
        E_ACCOUNT_KIT_INVALID_INPUT
      )
    await assert.rejects(
      () => account.invitations.accept({ token: 'bad', password: '😀'.repeat(128) }),
      E_ACCOUNT_KIT_INVALID_TOKEN
    )
    for (const value of [null, 42, 'bad', 'a'.repeat(43)])
      await assert.rejects(
        () => account.invitations.accept({ token: value as never, password: 'newPassword123' }),
        E_ACCOUNT_KIT_INVALID_TOKEN
      )
    assert.isNotNull(await kit.db.from('account_invitations').where('id', invitation.id).first())
    await kit.db
      .from('account_invitations')
      .where('id', invitation.id)
      .update({ expires_at: dbTime(kit, DateTime.utc().minus({ seconds: 1 })) })
    await assert.rejects(
      () => account.invitations.accept({ token, password: 'newPassword123' }),
      E_ACCOUNT_KIT_INVALID_TOKEN
    )
    assert.lengthOf(await kit.db.from('users').where('email', invitation.email), 0)
    const fresh = await issue(account, recorder, actor.id, 'fresh@example.test')
    await kit.db.from('account_invitations').where('id', fresh.invitation.id).delete()
    await assert.rejects(
      () => account.invitations.accept({ token: fresh.token, password: 'newPassword123' }),
      E_ACCOUNT_KIT_INVALID_TOKEN
    )
    const again = await issue(account, recorder, actor.id, 'again@example.test')
    await account.invitations.accept({ token: again.token, password: 'newPassword123' })
    await assert.rejects(
      () => account.invitations.accept({ token: again.token, password: 'newPassword123' }),
      E_ACCOUNT_KIT_INVALID_TOKEN
    )
  })

  test('registration after send rejects and restores the invitation', async ({ assert }) => {
    const actor = await createActor()
    const users = makeUsersAdapter(kit.db, kit.hash)
    let attemptedCreate = 0
    const { account, recorder } = service({
      users: {
        ...users,
        async create(attrs, trx) {
          attemptedCreate++
          return users.create(attrs, trx)
        },
      },
    })
    const { invitation, token } = await issue(account, recorder, actor.id)
    await kit.db.transaction((trx) =>
      users.create(
        {
          email: invitation.email,
          password: 'existingPassword123',
          unverifiedEmail: null,
        },
        trx
      )
    )
    await assert.rejects(
      () => account.invitations.accept({ token, password: 'newPassword123' }),
      E_ACCOUNT_KIT_EMAIL_ALREADY_REGISTERED
    )
    assert.equal(attemptedCreate, 0)
    assert.isNotNull(await kit.db.from('account_invitations').where('id', invitation.id).first())
    assert.lengthOf(await kit.db.from('users').where('email', invitation.email), 1)
  })

  test('callback write followed by throw rolls back user and token consumption', async ({
    assert,
  }) => {
    const actor = await createActor()
    const failure = new Error('callback failed')
    const { account, recorder } = service({
      onInvitationAccepted: async (_user, _invitation, trx) => {
        await trx.from('users').where('id', actor.id).update({ email_verified_at: null })
        throw failure
      },
    })
    const { invitation, token } = await issue(account, recorder, actor.id)
    try {
      await account.invitations.accept({ token, password: 'newPassword123' })
      assert.fail('expected callback failure')
    } catch (error) {
      assert.equal(error, failure)
    }
    const actorRow = await kit.db.from('users').where('id', actor.id).first()
    assert.isNotNull(actorRow.email_verified_at)
    assert.lengthOf(await kit.db.from('users').where('email', invitation.email), 0)
    assert.isNotNull(await kit.db.from('account_invitations').where('id', invitation.id).first())
  })

  test('the generated invitation hook setup error rolls back user creation and token consumption', async ({
    assert,
  }) => {
    const actor = await createActor()
    const setupError = new Error(
      'account_kit: implement onInvitationAccepted in config/account_kit.ts'
    )
    const { account, recorder } = service({
      onInvitationAccepted: async () => {
        throw setupError
      },
    })
    const { invitation, token } = await issue(account, recorder, actor.id)

    try {
      await account.invitations.accept({ token, password: 'newPassword123' })
      assert.fail('expected invitation hook setup error')
    } catch (error) {
      assert.equal(error, setupError)
    }

    assert.lengthOf(await kit.db.from('users').where('email', invitation.email), 0)
    assert.isNotNull(await kit.db.from('account_invitations').where('id', invitation.id).first())
    assert.lengthOf(recorder.calls, 1)
  })

  test('different scoped links serialize acceptance in address order', async ({ assert }) => {
    const actor = await createActor()
    const { account, recorder } = service()
    const first = await account.invitations.send({
      actorId: actor.id,
      email: 'person@example.test',
      role: 'admin',
      scope: 'first',
    })
    const firstToken = tokenFrom(recorder.calls.at(-1)!.args[1])
    await account.invitations.send({
      actorId: actor.id,
      email: 'person@example.test',
      role: 'admin',
      scope: 'second',
    })
    const secondToken = tokenFrom(recorder.calls.at(-1)!.args[1])
    const holder = await kit.db.transaction()
    const backend = await holder.rawQuery('select pg_backend_pid() as id')
    const holderId = String(backend.rows[0].id)
    await holder.from('account_invitations').where('id', first.id).forUpdate()
    const operations: Promise<unknown>[] = []
    let outcomes: Promise<PromiseSettledResult<unknown>[]> | undefined
    let blockerId = holderId
    try {
      for (const token of [firstToken, secondToken]) {
        const tracked = startWithBackendId(kit, () =>
          account.invitations.accept({ token, password: 'newPassword123' })
        )
        operations.push(tracked.operation)
        void tracked.operation.catch(() => {})
        const id = await tracked.backendId
        await waitForDatabaseLockWait(kit, assert, id, blockerId, 'account_invitations')
        blockerId = id
      }
      outcomes = Promise.allSettled(operations)
    } finally {
      await holder.rollback()
      if (!outcomes) await Promise.allSettled(operations)
    }
    const results = await outcomes!
    assert.lengthOf(
      results.filter((result) => result.status === 'fulfilled'),
      1
    )
    const failures = results.filter(
      (result) => result.status === 'rejected'
    ) as PromiseRejectedResult[]
    assert.lengthOf(failures, 1)
    assert.instanceOf(failures[0].reason, E_ACCOUNT_KIT_INVALID_TOKEN)
    assert.lengthOf(await kit.db.from('users').where('email', 'person@example.test'), 1)
    assert.lengthOf(
      await kit.db.from('account_invitations').where('email', 'person@example.test'),
      0
    )
  })
    .skip(testEngine !== 'pg')
    .timeout(20_000)

  test('acceptance and verified social signup share the user-email lock order', async ({
    assert,
  }) => {
    const actor = await createActor()
    const issuer = service()
    const { token } = await issue(issuer.account, issuer.recorder, actor.id)
    const users = makeUsersAdapter(kit.db, kit.hash)
    const acceptanceReady = createBarrier('acceptance before user creation')
    const socialReady = createBarrier('social user created')
    let release!: () => void
    const hold = new Promise<void>((resolve) => {
      release = resolve
    })
    const accepting = makeService(kit, {
      users: {
        ...users,
        async create(attrs, trx) {
          acceptanceReady.signal()
          await hold
          return users.create(attrs, trx)
        },
      },
    }).account
    const social = makeService(kit, {
      users: {
        ...users,
        async markEmailVerified(id, at, trx) {
          await users.markEmailVerified(id, at, trx)
          socialReady.signal()
        },
      },
      enabled: ['socialAuthentication', 'invitations', 'emailVerification'],
      authentication: { strategy: 'session', guard: 'web' },
      registration: { availability: 'open' },
      socialAuthentication: {
        providers: { github: provider('invite-race', 'person@example.test', true) },
      },
    }).account
    const start = await social.socialAuthentication.begin({
      provider: 'github',
      intent: 'login',
      clientChallenge,
    })
    const acceptance = accepting.invitations.accept({ token, password: 'newPassword123' })
    acceptanceReady.observe(acceptance)
    void acceptance.catch(() => {})
    let callback: Promise<unknown> | undefined
    try {
      await acceptanceReady.promise
      callback = social.socialAuthentication.callback({ state: start.state, callback: {} })
      socialReady.observe(callback)
      void callback.catch(() => {})
      await socialReady.promise
    } finally {
      release()
    }
    const outcomes = await Promise.allSettled([acceptance, callback!])
    assert.equal(outcomes[0].status, 'rejected')
    assert.instanceOf((outcomes[0] as PromiseRejectedResult).reason, E_ACCOUNT_KIT_INVALID_TOKEN)
    assert.equal(outcomes[1].status, 'fulfilled')
    assert.lengthOf(await kit.db.from('users').where('email', 'person@example.test'), 1)
    assert.lengthOf(
      await kit.db.from('account_invitations').where('email', 'person@example.test'),
      0
    )
  })
    .skip(testEngine !== 'pg')
    .timeout(20_000)

  test('independent concurrent accepts yield one user and one invalid token', async ({
    assert,
  }) => {
    const actor = await createActor()
    const { account, recorder } = service()
    const { invitation, token } = await issue(account, recorder, actor.id)
    const results = await Promise.allSettled([
      account.invitations.accept({ token, password: 'newPassword123' }),
      account.invitations.accept({ token, password: 'anotherPassword123' }),
    ])
    assert.lengthOf(
      results.filter((item) => item.status === 'fulfilled'),
      1
    )
    const rejected = results.filter((item) => item.status === 'rejected') as PromiseRejectedResult[]
    assert.lengthOf(rejected, 1)
    assert.instanceOf(rejected[0].reason, E_ACCOUNT_KIT_INVALID_TOKEN)
    assert.lengthOf(await kit.db.from('users').where('email', invitation.email), 1)
    assert.lengthOf(await kit.db.from('account_invitations').where('id', invitation.id), 0)
  })

  test('accept and plain registration race to one user with a mapped acceptance conflict', async ({
    assert,
  }) => {
    const actor = await createActor()
    const { account, recorder } = service()
    const { invitation, token } = await issue(account, recorder, actor.id)
    const users = makeUsersAdapter(kit.db, kit.hash)
    const results = await Promise.allSettled([
      account.invitations.accept({ token, password: 'newPassword123' }),
      transaction(kit.db, (trx) =>
        users.create(
          {
            email: invitation.email,
            password: 'plainPassword123',
            unverifiedEmail: null,
          },
          trx
        )
      ),
    ])
    assert.lengthOf(
      results.filter((item) => item.status === 'fulfilled'),
      1
    )
    const rejected = results.filter((item) => item.status === 'rejected') as PromiseRejectedResult[]
    assert.lengthOf(rejected, 1)
    const acceptWon = results[0].status === 'fulfilled'
    if (!acceptWon) assert.instanceOf(rejected[0].reason, E_ACCOUNT_KIT_EMAIL_ALREADY_REGISTERED)
    assert.lengthOf(await kit.db.from('users').where('email', invitation.email), 1)
    assert.lengthOf(
      await kit.db.from('account_invitations').where('id', invitation.id),
      acceptWon ? 0 : 1
    )
  })

  if (locksRows) {
    test('maps a real unique-email race after the transactional precheck', async ({ assert }) => {
      const actor = await createActor()
      const users = makeUsersAdapter(kit.db, kit.hash)
      let checked!: () => void
      let release!: () => void
      const afterCheck = new Promise<void>((resolve) => {
        checked = resolve
      })
      const hold = new Promise<void>((resolve) => {
        release = resolve
      })
      const { account, recorder } = service({
        users: {
          ...users,
          async findByEmail(email, trx) {
            const found = await users.findByEmail(email, trx)
            if (trx && email === 'person@example.test' && !found) {
              checked()
              await hold
            }
            return found
          },
        },
      })
      const { invitation, token } = await issue(account, recorder, actor.id)
      const accepting = account.invitations.accept({ token, password: 'newPassword123' })
      try {
        await afterCheck
        await transaction(kit.db, (trx) =>
          users.create(
            {
              email: invitation.email,
              password: 'plainPassword123',
              unverifiedEmail: null,
            },
            trx
          )
        )
      } finally {
        release()
      }
      await assert.rejects(() => accepting, E_ACCOUNT_KIT_EMAIL_ALREADY_REGISTERED)
      assert.lengthOf(await kit.db.from('users').where('email', invitation.email), 1)
      assert.isNotNull(await kit.db.from('account_invitations').where('id', invitation.id).first())
    })
  }
})
