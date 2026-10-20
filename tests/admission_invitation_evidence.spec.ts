import { DateTime } from 'luxon'
import { test } from '@japa/runner'
import { withInvitationEvidence } from '../src/admission/invitation_evidence.js'
import { transaction } from '../src/db.js'
import type { AccountUser, Invitation, Trx } from '../src/types.js'
import { useAdmissionApp } from './helpers/admission_schema.js'
import { allowDecisions, makeAdmission } from './helpers/admission.js'
import { invitationHelpers } from './helpers/invitations.js'

const invitationOnly = { invitation: { required: true as const } }

test.group('admission invitation evidence', (group) => {
  const kit = useAdmissionApp(group)
  const { createActor, issue } = invitationHelpers(kit)

  test('records evidence in the acceptance transaction, before the next callback', async ({
    assert,
  }) => {
    const seen: Array<{ role: string | null; source: string | null }> = []
    const { account, recorder, admission } = makeAdmission(
      kit,
      { ...invitationOnly, approval: { required: true, authorize: allowDecisions } },
      {
        onInvitationAccepted: withInvitationEvidence(async (user, _invitation, trx) => {
          const row = await trx.from('account_admissions').where('user_id', user.id).first()
          seen.push({ role: row?.invited_role ?? null, source: row?.invitation_source ?? null })
        }),
      }
    )
    const actor = await createActor()
    const { invitation, token } = await issue(
      account,
      recorder,
      actor.id,
      'new@example.test',
      'editor'
    )
    const user = await account.invitations.accept({ token, password: 'password123' })
    assert.deepEqual(seen, [{ role: 'editor', source: 'invitation' }])

    const row = await kit.db.from('account_admissions').where('user_id', user.id).first()
    assert.equal(row.invitation_id, invitation.id)
    assert.equal(row.invited_email, 'new@example.test')
    assert.isNull(row.approval_status)
    const result = await kit.db.transaction((trx) => admission.decide(user, trx))
    assert.deepEqual(result.requirements, {
      invitation: { met: true },
      approval: { met: false, status: 'pending', requested: false },
    })
  })

  test('a throwing next callback rolls back the evidence and the account', async ({ assert }) => {
    const { account, recorder } = makeAdmission(kit, invitationOnly, {
      onInvitationAccepted: withInvitationEvidence(async () => {
        throw new Error('role grant failed')
      }),
    })
    const actor = await createActor()
    const { token } = await issue(account, recorder, actor.id, 'new@example.test')
    await assert.rejects(
      () => account.invitations.accept({ token, password: 'password123' }),
      'role grant failed'
    )
    assert.isNull(await kit.db.from('users').where('email', 'new@example.test').first())
    assert.lengthOf(await kit.db.from('account_admissions'), 0)
    assert.lengthOf(await kit.db.from('account_invitations'), 1)
  })

  test('evidence survives pruning and is not replaced by a later invitation', async ({
    assert,
  }) => {
    const { account, recorder, admission } = makeAdmission(kit, invitationOnly, {
      onInvitationAccepted: withInvitationEvidence(),
    })
    const actor = await createActor()
    const { invitation, token } = await issue(account, recorder, actor.id, 'new@example.test')
    const user = await account.invitations.accept({ token, password: 'password123' })
    await account.maintenance.prune()
    assert.isTrue(await admission.isAdmitted(user.id))

    const later: Invitation = {
      ...invitation,
      id: invitation.id + 100,
      role: 'owner',
      expiresAt: DateTime.utc(),
      createdAt: DateTime.utc(),
      updatedAt: DateTime.utc(),
    }
    await transaction(kit.db, (trx: Trx) =>
      withInvitationEvidence()(user as AccountUser, later, trx)
    )
    const row = await kit.db.from('account_admissions').where('user_id', user.id).first()
    assert.equal(row.invitation_id, invitation.id)
    assert.equal(row.invited_role, 'admin')
    assert.lengthOf(await kit.db.from('account_admissions'), 1)
  })
})
