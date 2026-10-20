// Records invitation evidence inside the invitation acceptance transaction.
import { sqlTimestamp } from '../timestamps.js'
import type { AccountUser, Invitation, Trx } from '../types.js'
import { admissionTable, readAdmissionRow, upsertAdmissionRow } from './rows.js'

type InvitationAccepted = (user: AccountUser, invitation: Invitation, trx: Trx) => Promise<void>

/**
 * Returns an `onInvitationAccepted` callback that records invitation evidence through `trx`, then
 * runs `next`. A throwing `next` rolls back the evidence and the account together. Evidence already
 * on the account is kept: the first invitation is the history.
 */
export function withInvitationEvidence(next?: InvitationAccepted): InvitationAccepted {
  return async (user, invitation, trx) => {
    const existing = await readAdmissionRow(trx, user.id)
    if (!existing || existing.invitation_recorded_at === null) {
      const now = sqlTimestamp(trx)
      const evidence = {
        invitation_id: invitation.id,
        invited_email: invitation.email,
        invited_role: invitation.role,
        invitation_source: 'invitation',
        invitation_recorded_at: now,
      }
      // Only the invitation the bootstrap issued claims the approval waiting for its address.
      const attached =
        !existing &&
        Number(
          await trx
            .from(admissionTable)
            .where('bootstrap_email', invitation.email)
            .where('invitation_id', invitation.id)
            .whereNull('user_id')
            .update({ ...evidence, user_id: user.id, bootstrap_email: null, updated_at: now })
        ) > 0
      if (!attached) await upsertAdmissionRow(trx, user.id, evidence, now)
    }
    if (next) await next(user, invitation, trx)
  }
}
