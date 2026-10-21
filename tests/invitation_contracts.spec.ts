import { test } from '@japa/runner'
import {
  InvalidInputError,
  InvitationManagementDeniedError,
  InvitationNotFoundError,
} from '../src/errors.js'
import { useTestApp } from './helpers/app.js'
import { allowAll, insertUser, makeService, makeUsersAdapter } from './helpers/fakes.js'

test.group('invitation management contracts', (group) => {
  const kit = useTestApp(group)

  test('distinguishes missing and denied management internally', async ({ assert }) => {
    const actor = await insertUser(kit, { email: 'actor@example.test' })
    const { account } = makeService(kit)
    const invitation = await account.invitations.send({
      actorId: actor.id,
      email: 'invitee@example.test',
      role: 'user',
    })
    await assert.rejects(
      () => account.invitations.revoke({ actorId: actor.id, invitationId: 99999 }),
      InvitationNotFoundError
    )
    const denied = makeService(kit, {
      authorize: { ...allowAll, manageInvitation: async () => false },
    }).account
    await assert.rejects(
      () => denied.invitations.revoke({ actorId: actor.id, invitationId: invitation.id }),
      InvitationManagementDeniedError
    )
  })

  test('malformed management ids fail before actor lookup, policy, budgets or writes', async ({
    assert,
  }) => {
    const actor = await insertUser(kit, { email: 'actor@example.test' })
    const base = makeUsersAdapter(kit.db, kit.hash)
    let actorReads = 0
    let policyReads = 0
    const { account, recorder } = makeService(kit, {
      users: {
        ...base,
        async findById(...args) {
          actorReads++
          return base.findById(...args)
        },
      },
      authorize: {
        ...allowAll,
        async manageInvitation() {
          policyReads++
          return true
        },
      },
      invitationThrottle: { resendActor: { requests: 1, duration: '1h' } },
    })
    const invitation = await account.invitations.send({
      actorId: actor.id,
      email: 'invitee@example.test',
      role: 'user',
    })
    const originalRow = await kit.db.from('account_invitations').where('id', invitation.id).first()
    const tokenHash = originalRow.token_hash
    actorReads = 0
    for (const bad of [
      Number.NaN,
      Infinity,
      0,
      -1,
      1.5,
      Number.MAX_SAFE_INTEGER + 1,
      'abc',
      '1',
      null,
    ]) {
      for (const operation of ['resend', 'revoke'] as const) {
        await assert.rejects(
          () => account.invitations[operation]({ actorId: actor.id, invitationId: bad as number }),
          InvalidInputError
        )
      }
    }
    assert.equal(actorReads, 0)
    assert.equal(policyReads, 0)
    assert.lengthOf(recorder.calls, 1)
    const unchanged = await kit.db.from('account_invitations').where('id', invitation.id).first()
    assert.equal(unchanged.token_hash, tokenHash)
    await account.invitations.resend({ actorId: actor.id, invitationId: invitation.id })
    assert.lengthOf(recorder.calls, 2)
  })
})
