/* eslint-disable @unicorn/no-await-expression-member -- Keep each assertion next to the operation it inspects. */

import { test } from '@japa/runner'
import { AdmissionDecisionError } from '../src/admission/errors.js'
import type { AdmissionEvent } from '../src/admission/types.js'
import { CapabilityDisabledError, InvalidInputError, UserNotFoundError } from '../src/errors.js'
import { useAdmissionApp } from './helpers/admission_schema.js'
import { allRequirements, makeAdmission } from './helpers/admission.js'
import { insertUser } from './helpers/fakes.js'

test.group('admission operator', (group) => {
  const kit = useAdmissionApp(group)

  test('approves and revokes by email with no actor, through the same transitions', async ({
    assert,
  }) => {
    const events: AdmissionEvent[] = []
    const { admission } = makeAdmission(kit, {
      ...allRequirements,
      onAdmissionEvent: async (event) => void events.push(event),
    })
    const person = await insertUser(kit, { email: 'boss@example.test' })
    const approved = await admission.operator.approve({ email: ' Boss@Example.TEST ' })
    assert.deepEqual(approved.approval?.actorId, null)
    assert.equal(approved.approval?.status, 'approved')
    await assert.rejects(
      () => admission.operator.approve({ email: person.email }),
      AdmissionDecisionError
    )
    assert.equal(
      (await admission.operator.revoke({ email: person.email })).approval?.status,
      'revoked'
    )
    await assert.rejects(
      () => admission.operator.revoke({ email: person.email }),
      AdmissionDecisionError
    )
    assert.deepEqual(events, [
      {
        type: 'admission.approved',
        userId: person.id,
        actorId: null,
        operationId: (events[0] as { operationId: string }).operationId,
        source: 'operator',
      },
      {
        type: 'admission.revoked',
        userId: person.id,
        actorId: null,
        operationId: (events[1] as { operationId: string }).operationId,
        source: 'operator',
      },
    ])
  })

  test('grants invitation evidence once, storing a role that grants nothing', async ({
    assert,
  }) => {
    const events: AdmissionEvent[] = []
    const { admission } = makeAdmission(kit, {
      ...allRequirements,
      onAdmissionEvent: async (event) => void events.push(event),
    })
    const person = await insertUser(kit)
    const record = await admission.operator.grantInvitation({ email: person.email, role: 'owner' })
    assert.deepEqual(
      { ...record.invitation, recordedAt: undefined },
      {
        invitationId: null,
        email: person.email,
        role: 'owner',
        recordedAt: undefined,
        source: 'operator',
      }
    )
    await assert.rejects(
      () => admission.operator.grantInvitation({ email: person.email }),
      AdmissionDecisionError
    )
    assert.deepEqual(
      events.map((event) => [event.type, event.userId, 'source' in event ? event.source : null]),
      [['admission.invitation_granted', person.id, 'operator']]
    )
    const other = await insertUser(kit, { email: 'other@example.test' })
    assert.isNull(
      (await admission.operator.grantInvitation({ email: other.email })).invitation!.role
    )
  })

  test('reports unknown and malformed addresses, bad roles and disabled requirements', async ({
    assert,
  }) => {
    const { admission } = makeAdmission(kit)
    await assert.rejects(
      () => admission.operator.approve({ email: 'missing@example.test' }),
      UserNotFoundError
    )
    await assert.rejects(
      () => admission.operator.approve({ email: 'not-an-email' }),
      InvalidInputError
    )
    const person = await insertUser(kit)
    for (const role of ['', 'x'.repeat(65), 7])
      await assert.rejects(
        () => admission.operator.grantInvitation({ email: person.email, role: role as never }),
        InvalidInputError
      )
    const { admission: noInvitation } = makeAdmission(kit, {
      domain: { allowed: ['example.test'] },
    })
    await assert.rejects(
      () => noInvitation.operator.grantInvitation({ email: person.email }),
      CapabilityDisabledError
    )
  })
})
