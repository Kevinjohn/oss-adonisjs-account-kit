import { DateTime } from 'luxon'
// Shell-trusted admission changes for Ace commands: no actor, no `authorize`, no throttle.
import { randomUUID } from 'node:crypto'
import { lockUser, transaction } from '../db.ts'
import { isEmailShaped, normalizeEmail } from '../email.ts'
import {
  E_ACCOUNT_KIT_ADMISSION_DECISION,
  E_ACCOUNT_KIT_INVALID_INPUT,
  E_ACCOUNT_KIT_USER_NOT_FOUND,
} from '../errors.ts'
import { sqlTimestamp } from '../timestamps.ts'
import type { AccountUser } from '../types.ts'
import { requireApproval, requireInvitationRequirement } from './capability.ts'
import {
  applyTransition,
  approvalStatusByTransition,
  type AdmissionTransition,
} from './decisions.ts'
import { withAdmissionNotification } from './notifications.ts'
import { readAdmissionRow, toAdmissionRecord, upsertAdmissionRow } from './rows.ts'
import type { AdmissionContext } from './service.ts'
import type { AdmissionRecord } from './types.ts'

/** Lock and load the account an operator names by email, or `E_ACCOUNT_KIT_USER_NOT_FOUND`. */
async function lockSubject(
  deps: AdmissionContext,
  trx: Parameters<typeof lockUser>[0],
  email: unknown
): Promise<AccountUser> {
  if (!isEmailShaped(email)) throw new E_ACCOUNT_KIT_INVALID_INPUT('Invalid email')
  const found = await deps.accountConfig.users.findByEmail(normalizeEmail(email), trx)
  if (!found) throw new E_ACCOUNT_KIT_USER_NOT_FOUND()
  await lockUser(trx, deps.accountConfig, found.id)
  const subject = await deps.accountConfig.users.findById(found.id, trx)
  if (!subject) throw new E_ACCOUNT_KIT_USER_NOT_FOUND()
  return subject
}

/** Approve or revoke by email, with the same transitions as an approver and no actor. */
export async function applyOperatorDecision(
  deps: AdmissionContext,
  input: { email: string },
  transition: Extract<AdmissionTransition, 'approve' | 'revoke'>
): Promise<AdmissionRecord> {
  requireApproval(deps.config)
  const operationId = randomUUID()
  return withAdmissionNotification(
    deps.config,
    transaction(deps.db, async (trx) => {
      const subject = await lockSubject(deps, trx, input.email)
      return applyTransition(trx, subject, transition, null)
    }),
    (record) => ({
      type: `admission.${approvalStatusByTransition[transition]}`,
      userId: record.userId,
      actorId: null,
      operationId,
      source: 'operator',
    })
  )
}

/**
 * Record operator invitation evidence for an existing account. `role` is stored on the record
 * only; it grants nothing. Refuses an account that already has evidence.
 */
export async function grantOperatorInvitation(
  deps: AdmissionContext,
  input: { email: string; role?: string }
): Promise<AdmissionRecord> {
  requireInvitationRequirement(deps.config)
  if (
    input.role !== undefined &&
    (typeof input.role !== 'string' || input.role.length < 1 || input.role.length > 64)
  )
    throw new E_ACCOUNT_KIT_INVALID_INPUT('Invalid role')
  const operationId = randomUUID()
  return withAdmissionNotification(
    deps.config,
    transaction(deps.db, async (trx) => {
      const subject = await lockSubject(deps, trx, input.email)
      const existing = await readAdmissionRow(trx, subject.id)
      if (existing && existing.invitation_recorded_at !== null)
        throw new E_ACCOUNT_KIT_ADMISSION_DECISION('Invitation evidence is already recorded')
      const now = sqlTimestamp(trx, DateTime.utc())
      const row = await upsertAdmissionRow(
        trx,
        subject.id,
        {
          invitation_id: null,
          invited_email: subject.email,
          invited_role: input.role ?? null,
          invitation_source: 'operator',
          invitation_recorded_at: now,
        },
        now
      )
      return toAdmissionRecord(row, subject.email)
    }),
    (record) => ({
      type: 'admission.invitation_granted',
      userId: record.userId,
      operationId,
      source: 'operator',
    })
  )
}
