// Shell-trusted admission changes for Ace commands: no actor, no `authorize`, no throttle.
import { randomUUID } from 'node:crypto'
import { lockUser, transaction } from '../db.js'
import { isEmailShaped, normalizeEmail } from '../email.js'
import { InvalidInputError, UserNotFoundError } from '../errors.js'
import { sqlTimestamp } from '../timestamps.js'
import type { AccountUser } from '../types.js'
import { requireApproval, requireInvitationRequirement } from './capability.js'
import { applyTransition, outcome, type AdmissionTransition } from './decisions.js'
import { AdmissionDecisionError } from './errors.js'
import { withAdmissionEvent } from './events.js'
import { readAdmissionRow, toAdmissionRecord, upsertAdmissionRow } from './rows.js'
import type { AdmissionContext } from './service.js'
import type { AdmissionRecord } from './types.js'

/** Lock and load the account an operator names by email, or `UserNotFoundError`. */
async function lockSubject(
  deps: AdmissionContext,
  trx: Parameters<typeof lockUser>[0],
  email: unknown
): Promise<AccountUser> {
  if (!isEmailShaped(email)) throw new InvalidInputError('Invalid email')
  const found = await deps.accountConfig.users.findByEmail(normalizeEmail(email), trx)
  if (!found) throw new UserNotFoundError()
  await lockUser(trx, deps.accountConfig, found.id)
  const subject = await deps.accountConfig.users.findById(found.id, trx)
  if (!subject) throw new UserNotFoundError()
  return subject
}

/** Approve or revoke by email, with the same transitions as an approver and no actor. */
export function operatorDecision(
  deps: AdmissionContext,
  input: { email: string },
  transition: Extract<AdmissionTransition, 'approve' | 'revoke'>
): Promise<AdmissionRecord> {
  requireApproval(deps.config)
  const operationId = randomUUID()
  return withAdmissionEvent(
    deps.config,
    transaction(deps.db, async (trx) => {
      const subject = await lockSubject(deps, trx, input.email)
      return applyTransition(trx, subject, transition, null)
    }),
    (record) => ({
      type: `admission.${outcome[transition]}`,
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
export function operatorGrantInvitation(
  deps: AdmissionContext,
  input: { email: string; role?: string }
): Promise<AdmissionRecord> {
  requireInvitationRequirement(deps.config)
  if (
    input.role !== undefined &&
    (typeof input.role !== 'string' || input.role.length < 1 || input.role.length > 64)
  )
    throw new InvalidInputError('Invalid role')
  const operationId = randomUUID()
  return withAdmissionEvent(
    deps.config,
    transaction(deps.db, async (trx) => {
      const subject = await lockSubject(deps, trx, input.email)
      const existing = await readAdmissionRow(trx, subject.id)
      if (existing && existing.invitation_recorded_at !== null)
        throw new AdmissionDecisionError('Invitation evidence is already recorded')
      const now = sqlTimestamp(trx)
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
