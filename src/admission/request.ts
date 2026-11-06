// A signed-in person asks for approval.
import { randomUUID } from 'node:crypto'
import { currentInTransaction } from '../authentication.js'
import { transaction } from '../db.js'
import { InvalidSessionError, UnverifiedEmailError } from '../errors.js'
import { sqlTimestamp } from '../timestamps.js'
import type { CurrentAccountInput } from '../types.js'
import { requireApproval } from './capability.js'
import { withAdmissionEvent } from './events.js'
import { readAdmissionRow, toAdmissionRecord, upsertAdmissionRow } from './rows.js'
import type { AdmissionContext } from './service.js'
import type { AdmissionRecord } from './types.js'

/**
 * Records that the signed-in person asked for approval, once. Idempotent: a repeat returns the
 * record unchanged and emits nothing; so does a request from an account that already has a
 * decision. Refuses an unconfirmed account.
 */
export async function requestAdmission(
  deps: AdmissionContext,
  input: CurrentAccountInput
): Promise<AdmissionRecord> {
  requireApproval(deps.config)
  const operationId = randomUUID()
  const { record } = await withAdmissionEvent(
    deps.config,
    transaction(deps.db, async (trx) => {
      const account = await currentInTransaction({ config: deps.accountConfig }, input, trx)
      if (!account.active) throw new UnverifiedEmailError()
      const user = await deps.accountConfig.users.findById(input.userId, trx)
      if (!user) throw new InvalidSessionError()
      let row = await readAdmissionRow(trx, user.id)
      const firstRequest = !row || row.requested_at === null
      // A decided account has nothing for an approver to act on, so it records but does not notify.
      const undecided = !row || row.approval_status === null
      if (firstRequest) {
        const now = sqlTimestamp(trx)
        row = await upsertAdmissionRow(trx, user.id, { requested_at: now }, now)
      }
      return { record: toAdmissionRecord(row!, user.email), first: firstRequest && undecided }
    }),
    (value) =>
      value.first ? { type: 'admission.requested', userId: value.record.userId, operationId } : null
  )
  return record
}
