import { DateTime } from 'luxon'
import { test } from '@japa/runner'
import { defineConfig } from '../src/account_kit.js'
import {
  AuthorizationError,
  DeliveryError,
  EmailAlreadyRegisteredError,
  InvalidInputError,
  InvitationPendingError,
  PostCommitError,
} from '../src/errors.js'
import { hashToken } from '../src/tokens.js'
import { useTestApp } from './helpers/app.js'
import { invitationHelpers } from './helpers/invitations.js'
import {
  accountKit,
  allowAll,
  makeConfig,
  makeNotify,
  makeUsersAdapter,
  tokenFrom,
} from './helpers/fakes.js'
import { faultAfterCommit } from './helpers/fault_after_commit.js'
import { dbTime } from './helpers/db_time.js'
import { createSqlUsersAdapter } from '../adapters/sql.js'
import { fakeHash } from './helpers/adapter_contract_fixture.js'
import { locksRows, testEngine } from './helpers/dialect.js'
import { startWithBackendId, waitForDatabaseLockWait } from './helpers/lock_coordination.js'

test.group('invitations.send', (group) => {
  const kit = useTestApp(group)

  const { createActor, service } = invitationHelpers(kit)

  test('stores normalized email, opaque role, inviter, hash, and timestamps; notifies after commit', async ({
    assert,
  }) => {
    const actor = await createActor()
    const recorder = makeNotify()
    let visibleAtNotification = false
    const { account } = service({
      expiresIn: { invitation: '2d' },
      notify: {
        ...recorder.notify,
        invitationProvision: async (invitation, url) => {
          visibleAtNotification = !!(await kit.db
            .from('account_invitations')
            .where('id', invitation.id)
            .first())
          await recorder.notify.invitationProvision(invitation, url)
        },
      },
    })
    const before = DateTime.utc()
    const invitation = await account.invitations.send({
      actorId: actor.id,
      email: '  PERSON@EXAMPLE.TEST  ',
      role: 'admin',
    })
    assert.equal(invitation.email, 'person@example.test')
    assert.equal(invitation.role, 'admin')
    assert.equal(invitation.inviterId, actor.id)
    assert.isTrue(visibleAtNotification)
    assert.lengthOf(recorder.calls, 1)
    const [notified, url] = recorder.calls[0].args
    assert.deepEqual(notified, invitation)
    const raw = tokenFrom(url)
    assert.match(raw, /^[A-Za-z0-9_-]{54}$/)
    const row = await kit.db.from('account_invitations').where('id', invitation.id).first()
    assert.equal(row.email, invitation.email)
    assert.equal(row.role, 'admin')
    assert.equal(row.inviter_id, actor.id)
    assert.equal(row.token_hash, hashToken(raw))
    assert.isFalse(Object.values(row).includes(raw))
    assert.isTrue(invitation.createdAt >= before)
    assert.isTrue(invitation.updatedAt >= before)
    assert.isTrue(invitation.expiresAt >= before.plus({ days: 2 }))
  })

  test('rejects missing actor and denied invite before writing or notifying', async ({
    assert,
  }) => {
    const actor = await createActor()
    const recorder = makeNotify()
    const calls: string[] = []
    const { account } = service({
      notify: recorder.notify,
      authorize: {
        ...allowAll,
        invite: async (_actor, role) => {
          calls.push(role)
          return role === 'user' ? true : (undefined as never)
        },
      },
    })
    await assert.rejects(
      () => account.invitations.send({ actorId: 99999, email: 'new@example.test', role: 'user' }),
      InvalidInputError
    )
    await assert.rejects(
      () =>
        account.invitations.send({ actorId: actor.id, email: 'new@example.test', role: 'admin' }),
      AuthorizationError
    )
    assert.deepEqual(calls, ['admin'])
    assert.lengthOf(await kit.db.from('account_invitations'), 0)
    assert.lengthOf(recorder.calls, 0)
    const allowed = await account.invitations.send({
      actorId: actor.id,
      email: 'new@example.test',
      role: 'user',
    })
    assert.equal(allowed.role, 'user')
    assert.deepEqual(calls, ['admin', 'user', 'user'])
  })

  test('re-runs invite inside the insert transaction with context.trx', async ({ assert }) => {
    const actor = await createActor()
    const contexts: unknown[] = []
    const { account } = service({
      authorize: {
        ...allowAll,
        invite: async (_actor, _role, context) => {
          contexts.push(context)
          return true
        },
      },
    })
    await account.invitations.send({ actorId: actor.id, email: 'new@example.test', role: 'user' })
    assert.lengthOf(contexts, 2)
    assert.isUndefined(contexts[0])
    assert.isDefined((contexts[1] as { trx?: unknown }).trx)
  })

  test('rejects when only the in-transaction invite check denies', async ({ assert }) => {
    const actor = await createActor()
    const recorder = makeNotify()
    const events: string[] = []
    let calls = 0
    const { account } = service({
      notify: recorder.notify,
      onLifecycleEvent: async (event) => {
        events.push(event.type)
      },
      authorize: { ...allowAll, invite: async () => ++calls === 1 },
    })
    await assert.rejects(
      () =>
        account.invitations.send({ actorId: actor.id, email: 'new@example.test', role: 'user' }),
      AuthorizationError
    )
    assert.equal(calls, 2)
    assert.lengthOf(await kit.db.from('account_invitations'), 0)
    assert.deepEqual(events, [])
    assert.lengthOf(recorder.calls, 0)
  })

  test('rejects a send blocked behind a committed demotion of the actor', async ({ assert }) => {
    if (!locksRows) return
    const actor = await createActor()
    // The shipped SQL adapter, which ignores `findById`'s `forUpdate` option.
    const { account } = service({
      users: createSqlUsersAdapter({ table: 'users', db: kit.db, ...fakeHash }),
      usersTable: 'users',
      authorize: {
        ...allowAll,
        invite: async (current) => current.email.endsWith('@example.test'),
      },
    })
    const demotion = await kit.db.transaction()
    let finished = false
    let send: Promise<unknown> | undefined
    try {
      await demotion.from('users').where('id', actor.id).update({ email: 'demoted@other.test' })
      const result = await demotion
        .rawQuery(
          testEngine === 'pg' ? 'select pg_backend_pid() as id' : 'select connection_id() as id'
        )
        .exec()
      const demotionBackendId = String((testEngine === 'mysql' ? result[0][0] : result.rows[0]).id)
      const tracked = startWithBackendId(kit, () =>
        account.invitations.send({ actorId: actor.id, email: 'new@example.test', role: 'user' })
      )
      send = tracked.operation
      void send.catch(() => {})
      await waitForDatabaseLockWait(kit, assert, await tracked.backendId, demotionBackendId)
      await demotion.commit()
      finished = true
      await assert.rejects(() => tracked.operation, AuthorizationError)
    } finally {
      if (!finished) await demotion.rollback()
      // Let a released send finish before the next test clears the tables.
      await send?.catch(() => {})
    }
    assert.lengthOf(await kit.db.from('account_invitations'), 0)
  }).timeout(10_000)

  test('rejects invalid raw email and role boundaries', async ({ assert }) => {
    const actor = await createActor()
    const { account } = service()
    const recorder = makeNotify()
    const { account: strictAccount } = service({ notify: recorder.notify })
    for (const email of [
      null,
      'a@b@c',
      'ab',
      '@ab',
      'ab@',
      '  @  ',
      'a b@example.test',
      'x'.repeat(255),
    ])
      await assert.rejects(
        () =>
          strictAccount.invitations.send({
            actorId: actor.id,
            email: email as never,
            role: 'user',
          }),
        InvalidInputError
      )
    for (const role of [null, '', 'a'.repeat(65)])
      await assert.rejects(
        () =>
          account.invitations.send({
            actorId: actor.id,
            email: 'new@example.test',
            role: role as never,
          }),
        InvalidInputError
      )
    assert.lengthOf(await kit.db.from('account_invitations'), 0)
    assert.lengthOf(recorder.calls, 0)
    const boundary = await account.invitations.send({
      actorId: actor.id,
      email: 'new@example.test',
      role: 'a'.repeat(64),
    })
    assert.equal(boundary.role.length, 64)
  })

  test('registered email and live pending email reject; expired row is replaced', async ({
    assert,
  }) => {
    const actor = await createActor()
    await createActor('registered@example.test')
    const { account } = service()
    await assert.rejects(
      () =>
        account.invitations.send({
          actorId: actor.id,
          email: ' REGISTERED@EXAMPLE.TEST ',
          role: 'user',
        }),
      EmailAlreadyRegisteredError
    )
    const first = await account.invitations.send({
      actorId: actor.id,
      email: 'new@example.test',
      role: 'user',
    })
    await assert.rejects(
      () =>
        account.invitations.send({ actorId: actor.id, email: ' NEW@EXAMPLE.TEST ', role: 'admin' }),
      InvitationPendingError
    )
    await kit.db
      .from('account_invitations')
      .where('id', first.id)
      .update({ expires_at: dbTime(kit, DateTime.utc().minus({ seconds: 1 })) })
    const replacement = await account.invitations.send({
      actorId: actor.id,
      email: 'new@example.test',
      role: 'admin',
    })
    assert.notEqual(replacement.id, first.id)
    assert.equal(replacement.role, 'admin')
    assert.lengthOf(await kit.db.from('account_invitations'), 1)
  })

  test('independent concurrent sends yield one invitation and one pending error', async ({
    assert,
  }) => {
    const actor = await createActor()
    const { account, recorder } = service()
    const results = await Promise.allSettled([
      account.invitations.send({ actorId: actor.id, email: 'new@example.test', role: 'user' }),
      account.invitations.send({ actorId: actor.id, email: 'NEW@EXAMPLE.TEST', role: 'user' }),
    ])
    assert.lengthOf(
      results.filter((item) => item.status === 'fulfilled'),
      1
    )
    const rejected = results.filter((item) => item.status === 'rejected') as PromiseRejectedResult[]
    assert.lengthOf(rejected, 1)
    assert.instanceOf(rejected[0].reason, InvitationPendingError)
    assert.lengthOf(await kit.db.from('account_invitations'), 1)
    assert.lengthOf(recorder.calls, 1)
  })

  test('notification and URL failures preserve the committed invitation', async ({ assert }) => {
    const actor = await createActor()
    const recorder = makeNotify()
    recorder.failOn('invitationProvision')
    const { account } = service({ notify: recorder.notify })
    try {
      await account.invitations.send({ actorId: actor.id, email: 'one@example.test', role: 'user' })
      assert.fail('expected delivery failure')
    } catch (error) {
      assert.instanceOf(error, DeliveryError)
      assert.instanceOf((error as DeliveryError).cause, Error)
    }
    const config = makeConfig({ users: makeUsersAdapter(kit.db, kit.hash) })
    const urlFailure = new Error('url failed')
    const { account: brokenUrl } = service({
      urls: {
        ...config.urls,
        invitation: () => {
          throw urlFailure
        },
      },
    })
    try {
      await brokenUrl.invitations.send({
        actorId: actor.id,
        email: 'two@example.test',
        role: 'user',
      })
      assert.fail('expected URL failure')
    } catch (error) {
      assert.instanceOf(error, DeliveryError)
      assert.equal((error as DeliveryError).cause, urlFailure)
    }
    assert.lengthOf(await kit.db.from('account_invitations'), 2)
  })

  test('delivers the invitation once after a committed cleanup fault', async ({ assert }) => {
    const actor = await createActor()
    const recorder = makeNotify()
    const failure = new Error('listener failed after commit')
    const events: string[] = []
    const config = defineConfig(
      makeConfig({
        users: makeUsersAdapter(kit.db, kit.hash),
        notify: recorder.notify,
        onLifecycleEvent: async (event) => {
          events.push(event.type)
        },
      })
    )
    const account = accountKit({ ...kit, db: faultAfterCommit(kit.db, failure) }, config)
    try {
      await account.invitations.send({ actorId: actor.id, email: 'new@example.test', role: 'user' })
      assert.fail('expected committed failure')
    } catch (error) {
      assert.instanceOf(error, PostCommitError)
      assert.isTrue((error as PostCommitError).committed)
      assert.equal((error as PostCommitError).cause, failure)
    }
    assert.deepEqual(
      recorder.calls.map((call) => call.method),
      ['invitationProvision']
    )
    assert.deepEqual(events, ['invitation.sent'])
    const row = await kit.db.from('account_invitations').where('email', 'new@example.test').first()
    assert.equal(row.token_hash, hashToken(tokenFrom(recorder.calls[0].args[1])))
  })
})
