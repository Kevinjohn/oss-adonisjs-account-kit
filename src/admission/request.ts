import { DateTime } from 'luxon'
// A signed-in person asks for approval.
import { randomUUID } from 'node:crypto'
import { requireCurrentAccountInTransaction } from '../authentication.ts'
import { transaction } from '../db.ts'
import { E_ACCOUNT_KIT_INVALID_SESSION, E_ACCOUNT_KIT_UNVERIFIED_EMAIL } from '../errors.ts'
import { sqlTimestamp } from '../timestamps.ts'
import type { CurrentAccountInput } from '../types.ts'
import { requireApproval } from './capability.ts'
import { withAdmissionNotification } from './notifications.ts'
import { readAdmissionRow, toAdmissionRecord, upsertAdmissionRow } from './rows.ts'
import type { AdmissionContext } from './service.ts'
import type { AdmissionRecord } from './types.ts'

/**
 * Records that the signed-in person asked for approval, once. Idempotent: a repeat returns the
 * record unchanged and emits nothing; so does a request from an account that already has a
 * decision. Refuses an unconfirmed account.
 *
 * @throws {AggregateError} If transaction work and cleanup fail before a commit is confirmed.
 */
export async function requestAdmission(
  deps: AdmissionContext,
  input: CurrentAccountInput
): Promise<AdmissionRecord> {
  requireApproval(deps.config)
  const operationId = randomUUID()
  const { record } = await withAdmissionNotification(
    deps.config,
    transaction(deps.db, async (trx) => {
      const account = await requireCurrentAccountInTransaction(
        { config: deps.accountConfig },
        input,
        trx
      )
      if (!account.active) throw new E_ACCOUNT_KIT_UNVERIFIED_EMAIL()
      const user = await deps.accountConfig.users.findById(input.userId, trx)
      if (!user) throw new E_ACCOUNT_KIT_INVALID_SESSION()
      let row = await readAdmissionRow(trx, user.id)
      const firstRequest = !row || row.requested_at === null
      // A decided account has nothing for an approver to act on, so it records but does not notify.
      const undecided = !row || row.approval_status === null
      if (firstRequest) {
        const now = sqlTimestamp(trx, DateTime.utc())
        row = await upsertAdmissionRow(trx, user.id, { requested_at: now }, now)
      }
      return { record: toAdmissionRecord(row!, user.email), first: firstRequest && undecided }
    }),
    (value) =>
      value.first ? { type: 'admission.requested', userId: value.record.userId, operationId } : null
  )
  return record
}
