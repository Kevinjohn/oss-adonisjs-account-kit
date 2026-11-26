import { DateTime } from 'luxon'
// Approve, reject and revoke: the approval transitions and who may make them.
import { randomUUID } from 'node:crypto'
import { lockUser, transaction } from '../db.ts'
import {
  E_ACCOUNT_KIT_ADMISSION_DECISION,
  E_ACCOUNT_KIT_AUTHORIZATION,
  E_ACCOUNT_KIT_INVALID_INPUT,
  E_ACCOUNT_KIT_USER_NOT_FOUND,
} from '../errors.ts'
import { sqlTimestamp } from '../timestamps.ts'
import type { AccountUser, Trx, UserId } from '../types.ts'
import { requireApproval } from './capability.ts'
import { evaluateAdmission } from './decision.ts'
import { withAdmissionNotification } from './notifications.ts'
import { readAdmissionRow, toAdmissionRecord, upsertAdmissionRow } from './rows.ts'
import type { AdmissionContext } from './service.ts'
import type { AdmissionApprovalStatus, AdmissionRecord } from './types.ts'

export type AdmissionTransition = 'approve' | 'reject' | 'revoke'
type Decided = Exclude<AdmissionApprovalStatus, 'pending'>

export const approvalStatusByTransition: Record<AdmissionTransition, Decided> = {
  approve: 'approved',
  reject: 'rejected',
  revoke: 'revoked',
}

/** The states each transition may start from; `null` is no decision yet. */
const allowedFrom: Record<AdmissionTransition, ReadonlyArray<Decided | null>> = {
  approve: [null, 'rejected', 'revoked'],
  reject: [null],
  revoke: ['approved'],
}

/** The new status, or `E_ACCOUNT_KIT_ADMISSION_DECISION` when the transition is not allowed from `from`. */
export function resolveNextApprovalStatus(
  from: Decided | null,
  transition: AdmissionTransition
): Decided {
  if (!allowedFrom[transition].includes(from))
    throw new E_ACCOUNT_KIT_ADMISSION_DECISION(
      `Cannot ${transition} an account whose approval is ${from ?? 'pending'}`
    )
  return approvalStatusByTransition[transition]
}

/** Apply a transition to the locked subject and return the updated record. */
export async function applyTransition(
  trx: Trx,
  subject: AccountUser,
  transition: AdmissionTransition,
  actorId: UserId | null
): Promise<AdmissionRecord> {
  const row = await readAdmissionRow(trx, subject.id)
  const status = resolveNextApprovalStatus(row?.approval_status ?? null, transition)
  const now = sqlTimestamp(trx, DateTime.utc())
  const updated = await upsertAdmissionRow(
    trx,
    subject.id,
    { approval_status: status, approval_actor_id: actorId, approval_decided_at: now },
    now
  )
  return toAdmissionRecord(updated, subject.email)
}

/**
 * An approver's decision. Locks the actor and the subject; the actor must exist, differ from the
 * subject, be admitted themselves and be allowed by `authorize.decide`.
 */
export async function decideAdmission(
  deps: AdmissionContext,
  input: { actorId: UserId; userId: UserId },
  transition: AdmissionTransition
): Promise<AdmissionRecord> {
  const { authorize } = requireApproval(deps.config)
  const { users } = deps.accountConfig
  const operationId = randomUUID()
  return withAdmissionNotification(
    deps.config,
    transaction(deps.db, async (trx) => {
      // Writing approval_actor_id takes a foreign-key lock on the actor's row, so two approvers
      // deciding on each other would deadlock if each locked only its subject. Lock both in id order.
      for (const id of [input.actorId, input.userId].sort((a, b) =>
        String(a) < String(b) ? -1 : 1
      ))
        await lockUser(trx, deps.accountConfig, id)
      const subject = await users.findById(input.userId, trx)
      if (!subject) throw new E_ACCOUNT_KIT_USER_NOT_FOUND()
      const actor = await users.findById(input.actorId, trx)
      if (!actor) throw new E_ACCOUNT_KIT_INVALID_INPUT('Unknown actor')
      if (String(actor.id) === String(subject.id)) throw new E_ACCOUNT_KIT_AUTHORIZATION()
      const actorRow = await readAdmissionRow(trx, actor.id)
      if (!evaluateAdmission(deps.config, actor, actorRow).admitted)
        throw new E_ACCOUNT_KIT_AUTHORIZATION()
      if ((await authorize.decide(actor, subject, { trx })) !== true)
        throw new E_ACCOUNT_KIT_AUTHORIZATION()
      return applyTransition(trx, subject, transition, actor.id)
    }),
    (record) => ({
      type: `admission.${approvalStatusByTransition[transition]}`,
      userId: record.userId,
      actorId: input.actorId,
      operationId,
    })
  )
}
