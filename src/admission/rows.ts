// Reads and writes `account_admissions` rows and maps them to records.
import type { QueryClientContract } from '@adonisjs/lucid/types/database'
import { readIsoTimestamp } from '../timestamps.js'
import type { Trx, UserId } from '../types.js'
import type { AdmissionApprovalStatus, AdmissionRecord } from './types.js'

export const admissionTable = 'account_admissions'

/** Any client that can read: a transaction or the default connection. */
export type AdmissionReader = Trx | QueryClientContract

/** The stored columns of one admission row. */
export interface AdmissionRow {
  id: number
  user_id: UserId
  requested_at: unknown
  invitation_id: number | null
  invited_email: string | null
  invited_role: string | null
  invitation_source: 'invitation' | 'operator' | null
  invitation_recorded_at: unknown
  approval_status: Exclude<AdmissionApprovalStatus, 'pending'> | null
  approval_actor_id: UserId | null
  approval_decided_at: unknown
  created_at: unknown
  updated_at: unknown
}

/** The user's admission row, or null when nothing was recorded for them. */
export async function readAdmissionRow(
  client: AdmissionReader,
  userId: UserId
): Promise<AdmissionRow | null> {
  return ((await client.from(admissionTable).where('user_id', userId).first()) ??
    null) as AdmissionRow | null
}

/** Map a stored row and the account's current email to the public record. */
export function toAdmissionRecord(row: AdmissionRow, email: string): AdmissionRecord {
  const recordedAt = readIsoTimestamp(row.invitation_recorded_at)
  const decidedAt = readIsoTimestamp(row.approval_decided_at)
  return {
    userId: row.user_id,
    email,
    requestedAt: readIsoTimestamp(row.requested_at),
    invitation:
      recordedAt && row.invitation_source && row.invited_email !== null
        ? {
            invitationId: row.invitation_id,
            email: row.invited_email,
            role: row.invited_role,
            recordedAt,
            source: row.invitation_source,
          }
        : null,
    approval:
      row.approval_status && decidedAt
        ? { status: row.approval_status, actorId: row.approval_actor_id, decidedAt }
        : null,
    createdAt: readIsoTimestamp(row.created_at)!,
    updatedAt: readIsoTimestamp(row.updated_at)!,
  }
}

/**
 * Update the user's row with `values`, or insert one. The caller holds the user lock or created
 * the user in this transaction, so the read and the write cannot race for the same user.
 */
export async function upsertAdmissionRow(
  trx: Trx,
  userId: UserId,
  values: Record<string, unknown>,
  now: string
): Promise<AdmissionRow> {
  const existing = await readAdmissionRow(trx, userId)
  if (existing)
    await trx
      .from(admissionTable)
      .where('id', existing.id)
      .update({ ...values, updated_at: now })
  else
    await trx
      .table(admissionTable)
      .insert({ ...values, user_id: userId, created_at: now, updated_at: now })
  return (await readAdmissionRow(trx, userId))!
}
