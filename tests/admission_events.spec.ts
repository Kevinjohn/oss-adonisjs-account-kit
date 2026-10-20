import { test } from '@japa/runner'
import type { AdmissionEvent } from '../src/admission/types.js'
import { PostCommitError } from '../src/errors.js'
import { useAdmissionApp } from './helpers/admission_schema.js'
import { allRequirements, makeAdmission, writeAdmissionRow } from './helpers/admission.js'
import { insertUser } from './helpers/fakes.js'

test.group('admission events', (group) => {
  const kit = useAdmissionApp(group)

  test('carry ids only, a fresh operation id each, after commit', async ({ assert }) => {
    const events: AdmissionEvent[] = []
    const { admission } = makeAdmission(
      kit,
      {
        ...allRequirements,
        onAdmissionEvent: async (event) => {
          // After commit: the change is visible outside the operation's transaction.
          const row = await kit.db.from('account_admissions').where('user_id', event.userId).first()
          assert.isDefined(row)
          events.push(event)
        },
      },
      { authentication: { strategy: 'session', guard: 'web' } }
    )
    const actor = await insertUser(kit, { email: 'actor@example.test' })
    await writeAdmissionRow(kit, actor.id, { invited: true, approval: 'approved' })
    const person = await insertUser(kit)
    await admission.request({ userId: person.id, revision: null })
    await admission.operator.grantInvitation({ email: person.email })
    await admission.approve({ actorId: actor.id, userId: person.id })

    assert.deepEqual(
      events.map((event) => event.type),
      ['admission.requested', 'admission.invitation_granted', 'admission.approved']
    )
    const allowed = ['type', 'userId', 'actorId', 'operationId', 'source']
    for (const event of events) {
      assert.includeMembers(allowed, Object.keys(event))
      assert.match(event.operationId, /^[0-9a-f-]{36}$/)
    }
    assert.lengthOf(new Set(events.map((event) => event.operationId)), 3)
  })

  test('a failing hook leaves each change committed', async ({ assert }) => {
    const { admission } = makeAdmission(
      kit,
      {
        ...allRequirements,
        onAdmissionEvent: async () => {
          throw new Error('hook down')
        },
      },
      { authentication: { strategy: 'session', guard: 'web' } }
    )
    const person = await insertUser(kit)
    await assert.rejects(
      () => admission.request({ userId: person.id, revision: null }),
      PostCommitError
    )
    await assert.rejects(
      () => admission.operator.grantInvitation({ email: person.email }),
      PostCommitError
    )
    const row = await kit.db.from('account_admissions').where('user_id', person.id).first()
    assert.isNotNull(row.requested_at)
    assert.isNotNull(row.invitation_recorded_at)
    // A repeat request changes nothing and emits nothing, so the hook cannot fail it.
    const repeat = await admission.request({ userId: person.id, revision: null })
    assert.isNotNull(repeat.requestedAt)
  })
})
