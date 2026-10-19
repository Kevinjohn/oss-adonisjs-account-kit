import { DateTime } from 'luxon'
import { test } from '@japa/runner'
import { defineConfig } from '../src/account_kit.js'
import {
  AuthorizationError,
  DeliveryError,
  InvalidInputError,
  InvitationNotFoundError,
  InvalidTokenError,
  PostCommitError,
} from '../src/errors.js'
import { hashToken } from '../src/tokens.js'
import { transaction } from '../src/db.js'
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
import { faultNthCommit } from './helpers/fault_after_commit.js'
import { lockNotAvailableCode, locksRows } from './helpers/dialect.js'
import { dbTime } from './helpers/db_time.js'

test.group('invitations.resend', (group) => {
  const kit = useTestApp(group)

  const { createActor, service, issue } = invitationHelpers(kit)

  test('resend rotates the token after commit, preserves invitation identity, and the new link works', async ({
    assert,
  }) => {
    const actor = await createActor()
    const recorder = makeNotify()
    let visibleAtNotification = false
    const { account } = service({
      notify: {
        ...recorder.notify,
        invitationProvision: async (invitation, url) => {
          if (recorder.calls.length === 1) {
            const raw = tokenFrom(url)
            const committed = await kit.db
              .from('account_invitations')
              .where('id', invitation.id)
              .first()
            visibleAtNotification = committed?.token_hash === hashToken(raw)
          }
          await recorder.notify.invitationProvision(invitation, url)
        },
      },
    })
    const { invitation: original, token: oldToken } = await issue(account, recorder, actor.id)
    const resent = await account.invitations.resend({
      actorId: actor.id,
      invitationId: original.id,
    })
    assert.equal(resent.id, original.id)
    assert.equal(resent.email, original.email)
    assert.equal(resent.role, original.role)
    assert.equal(resent.inviterId, original.inviterId)
    assert.equal(resent.createdAt.toISO(), original.createdAt.toISO())
    assert.isTrue(visibleAtNotification)
    assert.lengthOf(recorder.calls, 2)
    const newToken = tokenFrom(recorder.calls[1].args[1])
    assert.notEqual(newToken, oldToken)
    const row = await kit.db.from('account_invitations').where('id', original.id).first()
    assert.equal(row.token_hash, hashToken(newToken))
    assert.isFalse(Object.values(row).includes(newToken))
    assert.isNull(await account.invitations.inspect({ token: oldToken }))
    assert.deepEqual(await account.invitations.inspect({ token: newToken }), {
      email: original.email,
      role: original.role,
    })
    await assert.rejects(
      () => account.invitations.accept({ token: oldToken, password: 'password123' }),
      InvalidTokenError
    )
    const accepted = await account.invitations.accept({ token: newToken, password: 'password123' })
    assert.equal(accepted.email, original.email)
  })

  test('resend renews an expired invitation and rejects accepted or missing ids', async ({
    assert,
  }) => {
    const actor = await createActor()
    const { account, recorder } = service()
    const { invitation, token } = await issue(account, recorder, actor.id)
    await kit.db
      .from('account_invitations')
      .where('id', invitation.id)
      .update({ expires_at: dbTime(kit, DateTime.utc().minus({ seconds: 1 })) })
    const renewed = await account.invitations.resend({
      actorId: actor.id,
      invitationId: invitation.id,
    })
    assert.isTrue(renewed.expiresAt > DateTime.utc())
    assert.isNull(await account.invitations.inspect({ token }))
    await account.invitations.accept({
      token: tokenFrom(recorder.calls[1].args[1]),
      password: 'password123',
    })
    await assert.rejects(
      () => account.invitations.resend({ actorId: actor.id, invitationId: invitation.id }),
      InvitationNotFoundError
    )
    await assert.rejects(
      () => account.invitations.resend({ actorId: actor.id, invitationId: 99999 }),
      InvitationNotFoundError
    )
  })

  test('send and resend return the row they wrote when other invitations exist', async ({
    assert,
  }) => {
    const actor = await createActor()
    const { account, recorder } = service()
    await issue(account, recorder, actor.id, 'earlier@example.test', 'member')
    const { invitation } = await issue(account, recorder, actor.id, 'later@example.test')
    assert.equal(invitation.email, 'later@example.test')
    assert.equal(invitation.role, 'admin')
    const renewed = await account.invitations.resend({
      actorId: actor.id,
      invitationId: invitation.id,
    })
    assert.equal(renewed.id, invitation.id)
    assert.equal(renewed.email, 'later@example.test')
  })

  test('resend requires exact manage and current stored-role grant before any rotation', async ({
    assert,
  }) => {
    const actor = await createActor()
    const { account: sender, recorder } = service()
    const { invitation, token } = await issue(sender, recorder, actor.id)
    const initial = await kit.db.from('account_invitations').where('id', invitation.id).first()
    const managedDenied = service({
      authorize: { ...allowAll, manageInvitation: async () => undefined as never },
    }).account
    await assert.rejects(
      () => managedDenied.invitations.resend({ actorId: actor.id, invitationId: invitation.id }),
      AuthorizationError
    )
    const roles: string[] = []
    const grantDenied = service({
      authorize: {
        ...allowAll,
        invite: async (_actor, role) => {
          roles.push(role)
          return role === 'user'
        },
      },
    }).account
    await assert.rejects(
      () => grantDenied.invitations.resend({ actorId: actor.id, invitationId: invitation.id }),
      AuthorizationError
    )
    assert.deepEqual(roles, ['admin'])
    const missingGrant = service({
      authorize: { ...allowAll, invite: async () => undefined as never },
    }).account
    await assert.rejects(
      () => missingGrant.invitations.resend({ actorId: actor.id, invitationId: invitation.id }),
      AuthorizationError
    )
    await assert.rejects(
      () => sender.invitations.resend({ actorId: 99999, invitationId: invitation.id }),
      InvalidInputError
    )
    const unchanged = await kit.db.from('account_invitations').where('id', invitation.id).first()
    assert.equal(unchanged.token_hash, initial.token_hash)
    assert.deepEqual(await sender.invitations.inspect({ token }), {
      email: invitation.email,
      role: invitation.role,
    })
  })

  test('delivery and URL failures leave the new token committed', async ({ assert }) => {
    const actor = await createActor()
    const recorder = makeNotify()
    const { account } = service({ notify: recorder.notify })
    const { invitation, token: oldToken } = await issue(account, recorder, actor.id)
    recorder.failOn('invitationProvision')
    try {
      await account.invitations.resend({ actorId: actor.id, invitationId: invitation.id })
      assert.fail('expected delivery failure')
    } catch (error) {
      assert.instanceOf(error, DeliveryError)
      assert.instanceOf((error as DeliveryError).cause, Error)
    }
    const newToken = tokenFrom(recorder.calls[1].args[1])
    assert.isNull(await account.invitations.inspect({ token: oldToken }))
    assert.deepEqual(await account.invitations.inspect({ token: newToken }), {
      email: invitation.email,
      role: invitation.role,
    })
    const urlFailure = new Error('invitation URL failed')
    const defaults = makeConfig({ users: makeUsersAdapter(kit.db, kit.hash) })
    const broken = service({
      urls: {
        ...defaults.urls,
        invitation: () => {
          throw urlFailure
        },
      },
    }).account
    try {
      await broken.invitations.resend({ actorId: actor.id, invitationId: invitation.id })
      assert.fail('expected URL failure')
    } catch (error) {
      assert.instanceOf(error, DeliveryError)
      assert.equal((error as DeliveryError).cause, urlFailure)
    }
    assert.isNull(await account.invitations.inspect({ token: newToken }))
    assert.isNotNull(await kit.db.from('account_invitations').where('id', invitation.id).first())
  })

  test('resend delivers the rotated token once after a committed cleanup fault', async ({
    assert,
  }) => {
    const actor = await createActor()
    const recorder = makeNotify()
    const events: string[] = []
    const { account } = service({
      notify: recorder.notify,
      onLifecycleEvent: async (event) => {
        events.push(event.type)
      },
    })
    const { invitation, token: oldToken } = await issue(account, recorder, actor.id)
    events.length = 0
    const failure = new Error('listener failed after commit')
    const config = defineConfig(
      makeConfig({
        users: makeUsersAdapter(kit.db, kit.hash),
        notify: recorder.notify,
        onLifecycleEvent: async (event) => {
          events.push(event.type)
        },
      })
    )
    // Resend runs a preflight transaction first; the rotation is the second one.
    const faulty = accountKit({ ...kit, db: faultNthCommit(kit.db, failure, 1) }, config)
    try {
      await faulty.invitations.resend({ actorId: actor.id, invitationId: invitation.id })
      assert.fail('expected committed failure')
    } catch (error) {
      assert.instanceOf(error, PostCommitError)
      assert.isTrue((error as PostCommitError).committed)
      assert.equal((error as PostCommitError).cause, failure)
    }
    assert.deepEqual(
      recorder.calls.map((call) => call.method),
      ['invitationProvision', 'invitationProvision']
    )
    assert.deepEqual(events, ['invitation.resent'])
    const newToken = tokenFrom(recorder.calls[1].args[1])
    assert.isNull(await account.invitations.inspect({ token: oldToken }))
    assert.deepEqual(await account.invitations.inspect({ token: newToken }), {
      email: invitation.email,
      role: invitation.role,
    })
  })

  test('a held resend lock makes an independent acceptance lose the old token', async ({
    assert,
  }) => {
    const actor = await createActor()
    let manageReady!: () => void
    let releaseManage!: () => void
    const ready = new Promise<void>((resolve) => {
      manageReady = resolve
    })
    const hold = new Promise<void>((resolve) => {
      releaseManage = resolve
    })
    let manageReads = 0
    const { account, recorder } = service({
      authorize: {
        ...allowAll,
        manageInvitation: async () => {
          if (++manageReads === 2) {
            manageReady()
            await hold
          }
          return true
        },
      },
    })
    const { invitation, token } = await issue(account, recorder, actor.id)
    const resending = account.invitations.resend({ actorId: actor.id, invitationId: invitation.id })
    const knex = kit.db.connection().getWriteClient()
    let attempted!: () => void
    const attemptedDelete = new Promise<void>((resolve) => {
      attempted = resolve
    })
    const onQuery = (query: { sql: string }) => {
      if (
        // PostgreSQL consumes with DELETE ... RETURNING; MySQL first locks the row to consume.
        (locksRows &&
          /delete from account_invitations|from `account_invitations` .* for update/i.test(
            query.sql
          )) ||
        (!locksRows && /update account_transaction_lock set version = version/i.test(query.sql))
      )
        attempted()
    }
    knex.on('query', onQuery)
    try {
      await ready
      const accepting = account.invitations.accept({ token, password: 'password123' })
      void accepting.catch(() => {})
      await attemptedDelete
      releaseManage()
      const rotated = await resending
      await assert.rejects(() => accepting, InvalidTokenError)
      assert.equal(rotated.id, invitation.id)
      assert.lengthOf(await kit.db.from('users').where('email', invitation.email), 0)
      assert.isNull(await account.invitations.inspect({ token }))
    } finally {
      releaseManage()
      knex.off('query', onQuery)
      await resending.catch(() => {})
    }
  }).timeout(6000)

  if (locksRows) {
    test('holds a PostgreSQL row lock through the permission callback', async ({ assert }) => {
      const actor = await createActor()
      let manageReady!: () => void
      let releaseManage!: () => void
      const ready = new Promise<void>((resolve) => {
        manageReady = resolve
      })
      const hold = new Promise<void>((resolve) => {
        releaseManage = resolve
      })
      let manageReads = 0
      const { account, recorder } = service({
        authorize: {
          ...allowAll,
          manageInvitation: async () => {
            if (++manageReads === 2) {
              manageReady()
              await hold
            }
            return true
          },
        },
      })
      const { invitation } = await issue(account, recorder, actor.id)
      const resending = account.invitations.resend({
        actorId: actor.id,
        invitationId: invitation.id,
      })
      try {
        await ready
        let conflict: unknown
        try {
          await transaction(kit.db, (trx) =>
            trx
              .rawQuery('SELECT id FROM account_invitations WHERE id = ? FOR UPDATE NOWAIT', [
                invitation.id,
              ])
              .exec()
          )
        } catch (error) {
          conflict = error
        }
        assert.equal((conflict as { code?: string } | undefined)?.code, lockNotAvailableCode)
      } finally {
        releaseManage()
        await resending
      }
    })
  }
})
