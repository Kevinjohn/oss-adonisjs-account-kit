import { test } from '@japa/runner'
import { withInvitationEvidence } from '../src/admission/invitation_evidence.js'
import type { AdmissionRecord } from '../src/admission/types.js'
import { useAdmissionApp } from './helpers/admission_schema.js'
import { makeAdmission, writeAdmissionRow } from './helpers/admission.js'
import { insertUser } from './helpers/fakes.js'
import { invitationHelpers } from './helpers/invitations.js'

const invitationOnly = { invitation: { required: true as const } }

test.group('admission record', (group) => {
  const kit = useAdmissionApp(group)
  const { createActor, issue } = invitationHelpers(kit)

  test('is null for an unknown user and for a user with no admission row', async ({ assert }) => {
    const { admission } = makeAdmission(kit, invitationOnly)
    const person = await insertUser(kit)
    assert.isNull(await admission.record(999_999))
    assert.isNull(await admission.record(person.id))
    await writeAdmissionRow(kit, person.id, { invited: true })
    const record = await admission.record(person.id)
    assert.equal(record?.userId, person.id)
  })

  test('returns the role an operator granted', async ({ assert }) => {
    const { admission } = makeAdmission(kit, invitationOnly)
    const person = await insertUser(kit)
    await admission.operator.grantInvitation({ email: person.email, role: 'admin' })
    const record = await admission.record(person.id)
    assert.equal(record?.email, person.email)
    assert.equal(record?.invitation?.role, 'admin')
    assert.equal(record?.invitation?.source, 'operator')
  })

  test('reads the invitation role inside the acceptance transaction', async ({ assert }) => {
    const seen: Array<AdmissionRecord | null> = []
    const setup = makeAdmission(kit, invitationOnly, {
      onInvitationAccepted: withInvitationEvidence(async (user, _invitation, trx) => {
        seen.push(await setup.admission.record(user.id, trx))
      }),
    })
    const actor = await createActor()
    const { invitation, token } = await issue(
      setup.account,
      setup.recorder,
      actor.id,
      'new@example.test',
      'editor'
    )
    const user = await setup.account.invitations.accept({ token, password: 'password123' })

    assert.lengthOf(seen, 1)
    assert.equal(seen[0]?.invitation?.role, 'editor')
    assert.equal(seen[0]?.invitation?.invitationId, invitation.id)
    const committed = await setup.admission.record(user.id)
    assert.equal(committed?.invitation?.role, 'editor')
  })

  test('treats ids like isAdmitted does', async ({ assert }) => {
    const { admission } = makeAdmission(kit, invitationOnly)
    const outcome = async (read: () => Promise<unknown>) => {
      try {
        const value = await read()
        return { value: value === null ? false : value }
      } catch (error) {
        return { error: (error as Error).constructor.name }
      }
    }
    for (const id of [999_999, '999999', 'not-an-id', 0, -1]) {
      assert.deepEqual(
        await outcome(() => admission.record(id as never)),
        await outcome(() => admission.isAdmitted(id as never)),
        `id ${JSON.stringify(id)}`
      )
    }
  })
})
