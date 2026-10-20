// Approve, reject and revoke: the approval transitions and who may make them.
import { randomUUID } from 'node:crypto'
import { lockUser, transaction } from '../db.js'
import { AuthorizationError, InvalidInputError, UserNotFoundError } from '../errors.js'
import { sqlTimestamp } from '../timestamps.js'
import type { AccountUser, Trx, UserId } from '../types.js'
import { requireApproval } from './capability.js'
import { evaluateAdmission } from './decision.js'
import { AdmissionDecisionError } from './errors.js'
import { withAdmissionEvent } from './events.js'
import { readAdmissionRow, toAdmissionRecord, upsertAdmissionRow } from './rows.js'
import type { AdmissionContext } from './service.js'
import type { AdmissionApprovalStatus, AdmissionRecord } from './types.js'

export type AdmissionTransition = 'approve' | 'reject' | 'revoke'
type Decided = Exclude<AdmissionApprovalStatus, 'pending'>

export const outcome: Record<AdmissionTransition, Decided> = {
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

/** The new status, or `AdmissionDecisionError` when the transition is not allowed from `from`. */
export function nextApprovalStatus(from: Decided | null, transition: AdmissionTransition): Decided {
  if (!allowedFrom[transition].includes(from))
    throw new AdmissionDecisionError(
      `Cannot ${transition} an account whose approval is ${from ?? 'pending'}`
    )
  return outcome[transition]
}

/** Apply a transition to the locked subject and return the updated record. */
export async function applyTransition(
  trx: Trx,
  subject: AccountUser,
  transition: AdmissionTransition,
  actorId: UserId | null
): Promise<AdmissionRecord> {
  const row = await readAdmissionRow(trx, subject.id)
  const status = nextApprovalStatus(row?.approval_status ?? null, transition)
  const now = sqlTimestamp(trx)
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
  return withAdmissionEvent(
    deps.config,
    transaction(deps.db, async (trx) => {
      // Writing approval_actor_id takes a foreign-key lock on the actor's row, so two approvers
      // deciding on each other would deadlock if each locked only its subject. Lock both in id order.
      for (const id of [input.actorId, input.userId].sort((a, b) =>
        String(a) < String(b) ? -1 : 1
      ))
        await lockUser(trx, deps.accountConfig, id)
      const subject = await users.findById(input.userId, trx)
      if (!subject) throw new UserNotFoundError()
      const actor = await users.findById(input.actorId, trx)
      if (!actor) throw new InvalidInputError('Unknown actor')
      if (String(actor.id) === String(subject.id)) throw new AuthorizationError()
      const actorRow = await readAdmissionRow(trx, actor.id)
      if (!evaluateAdmission(deps.config, actor, actorRow).admitted) throw new AuthorizationError()
      if ((await authorize.decide(actor, subject, { trx })) !== true) throw new AuthorizationError()
      return applyTransition(trx, subject, transition, actor.id)
    }),
    (record) => ({
      type: `admission.${outcome[transition]}`,
      userId: record.userId,
      actorId: input.actorId,
      operationId,
    })
  )
}
