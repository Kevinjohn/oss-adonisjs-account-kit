import { test } from '@japa/runner'
import { AdmissionDecisionError } from '../src/admission/errors.js'
import { nextApprovalStatus, type AdmissionTransition } from '../src/admission/decisions.js'

type Status = 'approved' | 'rejected' | 'revoked'

test.group('admission transitions', () => {
  test('follow the transition table and refuse every other cell', ({ assert }) => {
    const table: Record<string, Record<AdmissionTransition, Status | null>> = {
      none: { approve: 'approved', reject: 'rejected', revoke: null },
      approved: { approve: null, reject: null, revoke: 'revoked' },
      rejected: { approve: 'approved', reject: null, revoke: null },
      revoked: { approve: 'approved', reject: null, revoke: null },
    }
    for (const [from, row] of Object.entries(table))
      for (const [transition, expected] of Object.entries(row) as [
        AdmissionTransition,
        Status | null,
      ][]) {
        const start = from === 'none' ? null : (from as Status)
        if (expected) assert.equal(nextApprovalStatus(start, transition), expected)
        else assert.throws(() => nextApprovalStatus(start, transition), AdmissionDecisionError)
      }
  })
})
