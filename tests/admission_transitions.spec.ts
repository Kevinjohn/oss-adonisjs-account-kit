import { test } from '@japa/runner'
import { E_ACCOUNT_KIT_ADMISSION_DECISION } from '../src/errors.ts'
import { resolveNextApprovalStatus, type AdmissionTransition } from '../src/admission/decisions.ts'

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
        if (expected) assert.equal(resolveNextApprovalStatus(start, transition), expected)
        else
          assert.throws(
            () => resolveNextApprovalStatus(start, transition),
            E_ACCOUNT_KIT_ADMISSION_DECISION
          )
      }
  })
})
