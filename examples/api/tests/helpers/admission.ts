import { DateTime } from 'luxon'
import db from '@adonisjs/lucid/services/db'

/**
 * Give the user the owner role and an approved admission record with invitation evidence, as the
 * bootstrap of a first owner would. The example's invitation and admission routes need both.
 */
export async function grantAdmittedOwner(user: { id: number; email: string }) {
  const now = DateTime.utc().toJSDate()
  await db.table('role_assignments').insert({ user_id: user.id, role: 'owner' })
  await db.table('account_admissions').insert({
    user_id: user.id,
    invited_email: user.email,
    invitation_source: 'operator',
    invited_role: 'owner',
    invitation_recorded_at: now,
    approval_status: 'approved',
    approval_decided_at: now,
    created_at: now,
    updated_at: now,
  })
}
