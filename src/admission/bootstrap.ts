// Operator bootstrap: an operator invitation plus an approval waiting for the account it creates.
import { deletedCount } from '../consume_rows.js'
import { issueOperatorInvitation } from '../operator.js'
import { isEmailShaped, normalizeEmail } from '../email.js'
import { CapabilityDisabledError, InvalidInputError } from '../errors.js'
import { sqlTimestamp } from '../timestamps.js'
import type { OperatorInviteResult } from '../types.js'
import { requireApproval } from './capability.js'
import { admissionTable } from './rows.js'
import type { AdmissionContext } from './service.js'

function requireEmail(value: unknown): string {
  if (!isEmailShaped(value)) throw new InvalidInputError('Invalid email')
  return normalizeEmail(value)
}

/**
 * Atomically replace the invitation and its waiting approval, then expose the committed link.
 * A later bootstrap replaces the pair; cancellation removes only the waiting approval.
 */
export async function operatorBootstrap(
  deps: AdmissionContext,
  input: { email: string; role: string }
): Promise<OperatorInviteResult> {
  requireApproval(deps.config)
  const email = requireEmail(input.email)
  if (typeof input.role !== 'string' || input.role.length < 1 || input.role.length > 64)
    throw new InvalidInputError('Invalid role')
  if (!deps.accountConfig.enabled.includes('invitations'))
    throw new CapabilityDisabledError('invitations is disabled')
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
  if (!pending)
    throw new InvalidInputError('Bootstrap approval was replaced or cancelled; run bootstrap again')
  return issued
}

/** Delete the waiting approval for `email`. Returns whether there was one. */
export async function cancelBootstrap(deps: AdmissionContext, email: unknown): Promise<boolean> {
  const deleted = await deps.db
    .from(admissionTable)
    .where('bootstrap_email', requireEmail(email))
    .whereNull('user_id')
    .delete()
  return deletedCount(deleted) > 0
}
