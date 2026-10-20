// Pages through admission records for an approver.
import { AuthorizationError, InvalidInputError } from '../errors.js'
import type { UserId } from '../types.js'
import { requireApproval } from './capability.js'
import { decodeAdmissionCursor, encodeAdmissionCursor } from './cursor.js'
import { admissionTable, toAdmissionRecord, type AdmissionRow } from './rows.js'
import type { AdmissionContext } from './service.js'
import type { AdmissionApprovalStatus, AdmissionRecord } from './types.js'

const statuses: readonly AdmissionApprovalStatus[] = ['pending', 'approved', 'rejected', 'revoked']

/** One page of admission records and the cursor for the next, or null. */
export interface AdmissionPage {
  items: AdmissionRecord[]
  nextCursor: string | null
}

/**
 * Admission records ordered by creation, after `authorize.list` allows the actor. `pending` lists
 * people who asked and have no decision; omit `status` for every record.
 */
export async function listAdmissions(
  deps: AdmissionContext,
  input: { actorId: UserId; status?: AdmissionApprovalStatus; cursor?: string; limit?: number }
): Promise<AdmissionPage> {
  const { authorize } = requireApproval(deps.config)
  const limit = input.limit ?? 25
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new InvalidInputError('Invalid admission page limit')
  if (input.status !== undefined && !statuses.includes(input.status))
    throw new InvalidInputError('Invalid admission status')
  const position = input.cursor === undefined ? null : decodeAdmissionCursor(input.cursor)
  const { users } = deps.accountConfig
  const actor = await users.findById(input.actorId)
  if (!actor) throw new InvalidInputError('Unknown actor')
  if ((await authorize.list(actor)) !== true) throw new AuthorizationError()

  const query = deps.db
    .from(admissionTable)
    .whereNotNull('user_id')
    .orderBy('created_at', 'asc')
    .orderBy('id', 'asc')
    .limit(limit + 1)
  if (input.status === 'pending') query.whereNotNull('requested_at').whereNull('approval_status')
  else if (input.status) query.where('approval_status', input.status)
  if (position)
    query.where((builder) =>
      builder
        .where('created_at', '>', position.createdAt)
        .orWhere((nested) =>
          nested.where('created_at', position.createdAt).where('id', '>', position.id)
        )
    )
  const rows = (await query) as AdmissionRow[]
  const page = rows.slice(0, limit)
  const items: AdmissionRecord[] = []
  for (const row of page) {
    const user = await users.findById(row.user_id)
    // The account can be deleted between the two reads; it no longer has a record.
    if (user) items.push(toAdmissionRecord(row, user.email))
  }
  const last = rows.length > limit ? page.at(-1)! : null
  return {
    items,
    nextCursor: last ? encodeAdmissionCursor(last.created_at, last.id) : null,
  }
}
