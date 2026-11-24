// Operator bootstrap: an operator invitation plus an approval waiting for the account it creates.
import { countDeletedRowsFromResult } from '../consume_rows.js'
import { issueOperatorInvitation } from '../operator.js'
import { isInvitationRole } from '../invitation_input.js'
import { isEmailShaped, normalizeEmail } from '../email.js'
import {
  E_ACCOUNT_KIT_BOOTSTRAP_APPROVAL_CHANGED,
  E_ACCOUNT_KIT_CAPABILITY_DISABLED,
  E_ACCOUNT_KIT_INVALID_INPUT,
  E_ACCOUNT_KIT_EMAIL_INVALID,
} from '../errors.js'
import { sqlTimestamp } from '../timestamps.js'
import type { OperatorInviteResult } from '../types.js'
import { requireApproval } from './capability.js'
import { admissionTable } from './rows.js'
import type { AdmissionContext } from './service.js'

function requireEmail(value: unknown): string {
  if (!isEmailShaped(value)) throw new E_ACCOUNT_KIT_EMAIL_INVALID('Invalid email')
  return normalizeEmail(value)
}

/**
 * Atomically replace the invitation and its waiting approval, then expose the committed link.
 * A later bootstrap replaces the pair; cancellation removes only the waiting approval.
 */
export async function bootstrapOperatorInvitation(
  deps: AdmissionContext,
  input: { email: string; role: string }
): Promise<OperatorInviteResult> {
  requireApproval(deps.config)
  const email = requireEmail(input.email)
  if (!isInvitationRole(input.role)) throw new E_ACCOUNT_KIT_INVALID_INPUT('Invalid role')
  if (!deps.accountConfig.enabled.includes('invitations'))
    throw new E_ACCOUNT_KIT_CAPABILITY_DISABLED('invitations is disabled')
  const issued = await issueOperatorInvitation(
    { config: deps.accountConfig, db: deps.db },
    { email, role: input.role, deliver: 'print' },
    async (invitation, trx) => {
      const now = sqlTimestamp(trx)
      await trx.from(admissionTable).where('bootstrap_email', email).whereNull('user_id').delete()
      await trx.table(admissionTable).insert({
        user_id: null,
        bootstrap_email: email,
        invitation_id: invitation.id,
        approval_status: 'approved',
        approval_actor_id: null,
        approval_decided_at: now,
        created_at: now,
        updated_at: now,
      })
    }
  )
  const pending = await deps.db
    .from(admissionTable)
    .where('bootstrap_email', email)
    .whereNull('user_id')
    .where('invitation_id', issued.invitation.id)
    .first()
  if (!pending) throw new E_ACCOUNT_KIT_BOOTSTRAP_APPROVAL_CHANGED()
  return issued
}

/** Delete the waiting approval for `email`. Returns whether there was one. */
export async function cancelBootstrap(deps: AdmissionContext, email: unknown): Promise<boolean> {
  const deleted = await deps.db
    .from(admissionTable)
    .where('bootstrap_email', requireEmail(email))
    .whereNull('user_id')
    .delete()
  return countDeletedRowsFromResult(deleted) > 0
}
