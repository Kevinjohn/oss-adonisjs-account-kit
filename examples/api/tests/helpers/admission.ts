import { DateTime } from 'luxon'
import db from '@adonisjs/lucid/services/db'

type Person = { id: number | string; email: string }

/** Record operator invitation evidence and an approval, so the user is admitted. */
export async function grantAdmission(user: Person) {
  const now = DateTime.utc().toJSDate()
  await db.table('account_admissions').insert({
    user_id: user.id,
    invited_email: user.email,
    invitation_source: 'operator',
    invitation_recorded_at: now,
    approval_status: 'approved',
    approval_decided_at: now,
    created_at: now,
    updated_at: now,
  })
}

/**
 * Give the user the owner role and admission, as the bootstrap of a first owner would. The
 * example's invitation and admission routes need both.
 */
export async function grantAdmittedOwner(user: Person) {
  await db.table('role_assignments').insert({ user_id: user.id, role: 'owner' })
  await grantAdmission(user)
}
