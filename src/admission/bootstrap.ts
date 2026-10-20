// Operator bootstrap: an operator invitation plus an approval waiting for the account it creates.
import type { AccountKit } from '../account_kit.js'
import { deletedCount } from '../consume_rows.js'
import { transaction } from '../db.js'
import { isEmailShaped, normalizeEmail } from '../email.js'
import { EmailAlreadyRegisteredError, InvalidInputError } from '../errors.js'
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
 * Write an approval for `email` that no account holds yet, then issue an operator invitation and
 * return it with its printed link. A second bootstrap for the address replaces the approval. The
 * approval records the invitation's id, so only that invitation claims it. When the invitation
 * cannot be issued, this call's approval is removed again.
 */
export async function operatorBootstrap(
  kit: AccountKit,
  deps: AdmissionContext,
  input: { email: string; role: string }
): Promise<OperatorInviteResult> {
  requireApproval(deps.config)
  const email = requireEmail(input.email)
  if (typeof input.role !== 'string' || input.role.length < 1 || input.role.length > 64)
    throw new InvalidInputError('Invalid role')
  if (await deps.accountConfig.users.findByEmail(email)) throw new EmailAlreadyRegisteredError()
  const rowId = await transaction(deps.db, async (trx) => {
    const now = sqlTimestamp(trx)
    await trx.from(admissionTable).where('bootstrap_email', email).whereNull('user_id').delete()
    await trx.table(admissionTable).insert({
      user_id: null,
      bootstrap_email: email,
      approval_status: 'approved',
      approval_actor_id: null,
      approval_decided_at: now,
      created_at: now,
      updated_at: now,
    })
    // The address is unique, so the waiting row read back inside this transaction is this call's.
    const row = await trx
      .from(admissionTable)
      .where('bootstrap_email', email)
      .whereNull('user_id')
      .select('id')
      .first()
    return row.id as number
  })
  // A concurrent bootstrap may replace this row, so both writes below touch only this row.
  const own = () => deps.db.from(admissionTable).where('id', rowId).whereNull('user_id')
  try {
    const issued = await kit.operator.invite({ email, role: input.role, deliver: 'print' })
    await own().update({ invitation_id: issued.invitation.id })
    return issued
  } catch (error) {
    await own().delete()
    throw error
  }
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
