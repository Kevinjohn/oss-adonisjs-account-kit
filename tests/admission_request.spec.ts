import { test } from '@japa/runner'
import type { AdmissionEvent } from '../src/admission/types.js'
import { InvalidSessionError, UnverifiedEmailError } from '../src/errors.js'
import { useAdmissionApp } from './helpers/admission_schema.js'
import { allowDecisions, makeAdmission, writeAdmissionRow } from './helpers/admission.js'
import { insertUser } from './helpers/fakes.js'

const authentication = { strategy: 'session' as const, guard: 'web' }

test.group('admission request', (group) => {
  const kit = useAdmissionApp(group)

  test('records the request once and emits one event', async ({ assert }) => {
    const events: AdmissionEvent[] = []
    const { admission } = makeAdmission(
      kit,
      {
        approval: { required: true, authorize: allowDecisions },
        onAdmissionEvent: async (event) => void events.push(event),
      },
      { authentication }
    )
    const person = await insertUser(kit)
    const input = { userId: person.id, revision: null }
    const first = await admission.request(input)
    assert.isNotNull(first.requestedAt)
    assert.isNull(first.approval)
    const second = await admission.request(input)
    assert.equal(second.requestedAt, first.requestedAt)
    assert.lengthOf(await kit.db.from('account_admissions'), 1)
    assert.deepEqual(
      events.map((event) => [event.type, event.userId]),
      [['admission.requested', person.id]]
    )
    const { decision } = await admission.current(input)
    assert.deepEqual(decision.requirements.approval, {
      met: false,
      status: 'pending',
      requested: true,
    })
  })

  test('keeps an earlier decision and adds the request to an existing row', async ({ assert }) => {
    const { admission } = makeAdmission(
      kit,
      { approval: { required: true, authorize: allowDecisions } },
      { authentication }
    )
    const person = await insertUser(kit)
    await writeAdmissionRow(kit, person.id, { approval: 'rejected' })
    const record = await admission.request({ userId: person.id, revision: null })
    assert.isNotNull(record.requestedAt)
    assert.equal(record.approval?.status, 'rejected')
  })

  test('refuses an unconfirmed account and an invalid credential without writing', async ({
    assert,
  }) => {
    const { admission } = makeAdmission(
      kit,
      { approval: { required: true, authorize: allowDecisions } },
      { authentication }
    )
    const person = await insertUser(kit, { verified: false })
    await assert.rejects(
      () => admission.request({ userId: person.id, revision: null }),
      UnverifiedEmailError
    )
    await assert.rejects(() => admission.request({ userId: person.id }), InvalidSessionError)
    assert.lengthOf(await kit.db.from('account_admissions'), 0)
  })
})
