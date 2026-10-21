import { DateTime } from 'luxon'
import { test } from '@japa/runner'
import { defineAdmission } from '../src/admission/config.js'
import { evaluateAdmission } from '../src/admission/decision.js'
import type { AdmissionRow } from '../src/admission/rows.js'
import type { AdmissionConfig } from '../src/admission/types.js'
import type { AccountUser } from '../src/types.js'
import { allowDecisions } from './helpers/admission.js'

type Requirement = 'domain' | 'invitation' | 'approval'
const requirementConfig: Record<Requirement, AdmissionConfig> = {
  domain: { domain: { allowed: ['example.test'] } },
  invitation: { invitation: { required: true } },
  approval: { approval: { required: true, authorize: allowDecisions } },
}
const combinations: Requirement[][] = [
  ['domain'],
  ['invitation'],
  ['approval'],
  ['domain', 'invitation'],
  ['domain', 'approval'],
  ['invitation', 'approval'],
  ['domain', 'invitation', 'approval'],
]

const user = (overrides: Partial<AccountUser> = {}): AccountUser => ({
  id: 1,
  email: 'person@example.test',
  unverifiedEmail: null,
  hasPassword: true,
  emailVerifiedAt: DateTime.utc(),
  ...overrides,
})
const row = (overrides: Partial<AdmissionRow> = {}): AdmissionRow => ({
  id: 1,
  user_id: 1,
  bootstrap_email: null,
  requested_at: '2026-10-20T00:00:00.000Z',
  invitation_id: 3,
  invited_email: 'person@example.test',
  invited_role: 'member',
  invitation_source: 'invitation',
  invitation_recorded_at: '2026-10-20T00:00:00.000Z',
  approval_status: 'approved',
  approval_actor_id: 2,
  approval_decided_at: '2026-10-20T00:00:00.000Z',
  created_at: '2026-10-20T00:00:00.000Z',
  updated_at: '2026-10-20T00:00:00.000Z',
  ...overrides,
})
/** The account and row that leave exactly one requirement unmet. */
const unmet: Record<Requirement, { user: AccountUser; row: AdmissionRow | null }> = {
  domain: { user: user({ email: 'person@outside.test' }), row: row() },
  invitation: { user: user(), row: row({ invitation_recorded_at: null }) },
  approval: { user: user(), row: row({ approval_status: null }) },
}

test.group('admission decision rules', () => {
  test('admits only when every enabled requirement is met, in each combination', ({ assert }) => {
    for (const enabled of combinations) {
      const config = defineAdmission(Object.assign({}, ...enabled.map((r) => requirementConfig[r])))
      const met = evaluateAdmission(config, user(), row())
      assert.isTrue(met.admitted, enabled.join('+'))
      assert.sameMembers(Object.keys(met.requirements), enabled)
      for (const missing of enabled) {
        const decision = evaluateAdmission(config, unmet[missing].user, unmet[missing].row)
        assert.isFalse(decision.admitted, `${enabled.join('+')} without ${missing}`)
        assert.isFalse(decision.requirements[missing]!.met)
        for (const other of enabled.filter((name) => name !== missing))
          assert.isTrue(decision.requirements[other]!.met, `${other} stays met`)
      }
    }
  })

  test('reports the approval state and whether it was requested', ({ assert }) => {
    const config = defineAdmission(requirementConfig.approval)
    assert.deepEqual(evaluateAdmission(config, user(), null).requirements.approval, {
      met: false,
      status: 'pending',
      requested: false,
    })
    assert.deepEqual(
      evaluateAdmission(config, user(), row({ approval_status: null })).requirements.approval,
      { met: false, status: 'pending', requested: true }
    )
    for (const status of ['rejected', 'revoked'] as const)
      assert.deepEqual(
        evaluateAdmission(config, user(), row({ approval_status: status, requested_at: null }))
          .requirements.approval,
        { met: false, status, requested: false }
      )
  })

  test('reports an unconfirmed address as unverified and an outside one as not allowed', ({
    assert,
  }) => {
    const config = defineAdmission(requirementConfig.domain)
    const legacy = user({ emailVerifiedAt: null, unverifiedEmail: null })
    assert.deepEqual(evaluateAdmission(config, legacy, null).requirements.domain, {
      met: false,
      reason: 'unverified',
    })
    const pending = user({ unverifiedEmail: 'person@example.test' })
    assert.deepEqual(evaluateAdmission(config, pending, null).requirements.domain, {
      met: false,
      reason: 'unverified',
    })
    assert.deepEqual(
      evaluateAdmission(config, user({ email: 'a@b@example.test' }), null).requirements.domain,
      { met: false, reason: 'not_allowed' }
    )
  })
})
