import db from '@adonisjs/lucid/services/db'
import type { AccountUser, Invitation, Trx } from '@kevinjohn/adonisjs-account-kit'
import type {
  AccountAdmission,
  AdmissionAuthorizeCallbacks,
} from '@kevinjohn/adonisjs-account-kit/admission'

/** True when the user holds the owner role in the example's `role_assignments` table. */
export async function isOwner(userId: number | string, trx?: Trx): Promise<boolean> {
  const query = trx ? trx.from('role_assignments') : db.from('role_assignments')
  return Boolean(await query.where('user_id', userId).where('role', 'owner').first())
}

/** An admitted owner: the authority for invitations and admission decisions. */
export async function isAdmittedOwner(
  admission: AccountAdmission,
  userId: number | string,
  trx?: Trx
): Promise<boolean> {
  return (await admission.isAdmitted(userId, trx)) && isOwner(userId, trx)
}

/** Denies access to accounts that carry the `disabled` role. */
export async function canAccess(user: AccountUser, trx: Trx): Promise<boolean> {
  return !(await trx
    .from('role_assignments')
    .where('user_id', user.id)
    .where('role', 'disabled')
    .first())
}

/** Roles an owner may grant by invitation. An allowlist: `Owner` or `disabled` are never granted. */
export const invitableRoles: readonly string[] = ['member', 'editor', 'viewer']

/** The list callback checks the owner role; the route's `admittedAccount()` gate checks admission. */
export const admissionAuthorize: AdmissionAuthorizeCallbacks = {
  decide: async (actor, _subject, context) => isOwner(actor.id, context?.trx),
  list: async (actor, context) => isOwner(actor.id, context?.trx),
}

/** Grants the invited role inside the acceptance transaction. */
export async function onInvitationAccepted(user: AccountUser, invitation: Invitation, trx: Trx) {
  await trx.table('role_assignments').insert({ user_id: user.id, role: invitation.role })
}
