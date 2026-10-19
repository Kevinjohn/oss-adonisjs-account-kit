import { test } from '@japa/runner'
import { defineConfig } from '../src/account_kit.js'
import {
  AuthorizationError,
  InvalidInputError,
  InvitationNotFoundError,
  InvalidTokenError,
  PostCommitError,
} from '../src/errors.js'
import { hashToken } from '../src/tokens.js'
import type { AccountUser } from '../src/types.js'
import { bootTestApp, useTestApp } from './helpers/app.js'
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
import { resetSchema } from './helpers/schema.js'
import { locksRows } from './helpers/dialect.js'

test.group('invitations.revoke', (group) => {
  const kit = useTestApp(group)

  const { createActor, service, issue } = invitationHelpers(kit)

  test('revoke emits the revoked event once after a committed cleanup fault', async ({
    assert,
  }) => {
    const actor = await createActor()
    const recorder = makeNotify()
    const events: string[] = []
    const { account } = service({ notify: recorder.notify })
    const { invitation } = await issue(account, recorder, actor.id)
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
    const faulty = accountKit({ ...kit, db: faultNthCommit(kit.db, failure, 0) }, config)
    try {
      await faulty.invitations.revoke({ actorId: actor.id, invitationId: invitation.id })
      assert.fail('expected committed failure')
    } catch (error) {
      assert.instanceOf(error, PostCommitError)
      assert.isTrue((error as PostCommitError).committed)
      assert.equal((error as PostCommitError).cause, failure)
    }
    assert.deepEqual(events, ['invitation.revoked'])
    assert.isNull(await kit.db.from('account_invitations').where('id', invitation.id).first())
  })

  test('revoke checks management permission, deletes the row, and cannot repeat', async ({
    assert,
  }) => {
    const actor = await createActor()
    const { account, recorder } = service()
    const { invitation, token } = await issue(account, recorder, actor.id)
    const denied = service({
      authorize: { ...allowAll, manageInvitation: async () => false },
    }).account
    await assert.rejects(
      () => denied.invitations.revoke({ actorId: actor.id, invitationId: invitation.id }),
      AuthorizationError
    )
    const missingPermission = service({
      authorize: { ...allowAll, manageInvitation: async () => undefined as never },
    }).account
    await assert.rejects(
      () =>
        missingPermission.invitations.revoke({ actorId: actor.id, invitationId: invitation.id }),
      AuthorizationError
    )
    assert.isNotNull(await kit.db.from('account_invitations').where('id', invitation.id).first())
    assert.isUndefined(
      await account.invitations.revoke({ actorId: actor.id, invitationId: invitation.id })
    )
    assert.lengthOf(await kit.db.from('account_invitations').where('id', invitation.id), 0)
    await assert.rejects(
      () => account.invitations.accept({ token, password: 'password123' }),
      InvalidTokenError
    )
    await assert.rejects(
      () => account.invitations.revoke({ actorId: actor.id, invitationId: invitation.id }),
      InvitationNotFoundError
    )
    await assert.rejects(
      () => account.invitations.revoke({ actorId: actor.id, invitationId: 99999 }),
      InvitationNotFoundError
    )
    await assert.rejects(
      () => account.invitations.revoke({ actorId: 99999, invitationId: invitation.id }),
      InvalidInputError
    )
  })

  if (!locksRows) {
    test('database-backed management policy reads use another pooled SQLite connection', async ({
      assert,
    }) => {
      const customKit = await bootTestApp({ sqlitePoolMax: 2 })
      try {
        await resetSchema(customKit)
        const users = makeUsersAdapter(customKit.db, customKit.hash)
        const actor = await customKit.db.transaction((trx) =>
          users.create(
            {
              email: 'actor@example.test',
              password: 'password123',
              unverifiedEmail: null,
            },
            trx
          )
        )
        const recorder = makeNotify()
        const knex = customKit.db.connection().getWriteClient()
        assert.equal(knex.client.pool.max, 2)
        let policy: 'manage' | 'invite' | null = null
        const policyReads: Array<{ policy: 'manage' | 'invite'; connection: string }> = []
        const invitationReads: string[] = []
        const onQuery = (query: { sql: string; __knexUid?: string }) => {
          if (policy && /select .* from [`"]?users/i.test(query.sql))
            policyReads.push({ policy, connection: query.__knexUid! })
          else if (/select .* from [`"]?account_invitations/i.test(query.sql))
            invitationReads.push(query.__knexUid!)
        }
        knex.on('query', onQuery)
        try {
          const readActor = async (id: AccountUser['id']) => {
            const row = await customKit.db.from('users').where('id', id).first()
            return row?.email === actor.email
          }
          const config = defineConfig(
            makeConfig({
              users,
              notify: recorder.notify,
              authorize: {
                ...allowAll,
                async manageInvitation(current, invitation) {
                  policy = 'manage'
                  try {
                    return invitation.inviterId === current.id && (await readActor(current.id))
                  } finally {
                    policy = null
                  }
                },
                async invite(current, role) {
                  policy = 'invite'
                  try {
                    return role === 'user' && (await readActor(current.id))
                  } finally {
                    policy = null
                  }
                },
              },
            })
          )
          const account = accountKit(customKit, config)
          const invitation = await account.invitations.send({
            actorId: actor.id,
            email: 'first@example.test',
            role: 'user',
          })
          policyReads.length = 0
          invitationReads.length = 0
          const resent = await account.invitations.resend({
            actorId: actor.id,
            invitationId: invitation.id,
          })
          assert.equal(resent.id, invitation.id)
          assert.deepEqual(
            policyReads.map((read) => read.policy),
            ['manage', 'invite', 'manage', 'invite']
          )
          assert.isNotEmpty(invitationReads)
          for (const read of policyReads) assert.notEqual(read.connection, invitationReads[0])
          const rotated = await customKit.db
            .from('account_invitations')
            .where('id', invitation.id)
            .first()
          assert.notEqual(rotated.token_hash, hashToken(tokenFrom(recorder.calls[0].args[1])))

          policyReads.length = 0
          invitationReads.length = 0
          await account.invitations.revoke({ actorId: actor.id, invitationId: invitation.id })
          assert.deepEqual(
            policyReads.map((read) => read.policy),
            ['manage']
          )
          assert.isNotEmpty(invitationReads)
          assert.notEqual(policyReads[0].connection, invitationReads[0])
          assert.lengthOf(
            await customKit.db.from('account_invitations').where('id', invitation.id),
            0
          )
        } finally {
          knex.off('query', onQuery)
        }
      } finally {
        await customKit.close()
      }
    })
  }
})
