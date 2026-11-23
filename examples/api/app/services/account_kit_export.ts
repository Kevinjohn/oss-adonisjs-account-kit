import type { AccountUser, Trx } from '@kevinjohn/adonisjs-account-kit'
import type { AccountAdmission } from '@kevinjohn/adonisjs-account-kit/admission'

/**
 * The account export: the admission record always, and the application's roles only for an
 * admitted account, since the export route accepts any valid credential.
 */
export async function exportAccountData(admission: AccountAdmission, user: AccountUser, trx: Trx) {
  const record = await trx
    .from('account_admissions')
    .select(
      'requested_at',
      'invited_email',
      'invited_role',
      'invitation_source',
      'invitation_recorded_at',
      'approval_status',
      'approval_decided_at'
    )
    .where('user_id', user.id)
    .first()
  if (!(await admission.isAdmitted(user.id, trx))) return { admission: record ?? null, roles: [] }
  const rows: Array<{ role: string }> = await trx
    .from('role_assignments')
    .select('role')
    .where('user_id', user.id)
  return { admission: record ?? null, roles: rows.map((row) => row.role) }
}
