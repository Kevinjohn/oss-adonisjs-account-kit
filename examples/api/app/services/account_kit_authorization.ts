import db from '@adonisjs/lucid/services/db'
import type { AccountUser, Invitation, Trx } from '@kevinjohn/adonisjs-account-kit'
import type { AdmissionAuthorizeCallbacks } from '@kevinjohn/adonisjs-account-kit/admission'
import type { AuthorizationCallbacks } from '@kevinjohn/adonisjs-account-kit/types'
import { isAdmitted } from './account_admission_access.js'

export { isAdmitted }
export { exportAccountData } from './account_kit_export.js'

/** True when the user holds the owner role in the example's `role_assignments` table. */
export async function isOwner(userId: number | string, trx?: Trx): Promise<boolean> {
  const query = trx ? trx.from('role_assignments') : db.from('role_assignments')
  return Boolean(await query.where('user_id', userId).where('role', 'owner').first())
}

/** An admitted owner: the authority for invitations and admission decisions. */
export async function isAdmittedOwner(userId: number | string, trx?: Trx): Promise<boolean> {
  return (await isAdmitted(userId, trx)) && isOwner(userId, trx)
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

/**
 * Admitted owners may invite to an allowed role, and manage and list invitations. The invitation
 * routes accept any valid credential, so admission is checked here, not by route middleware.
 */
export const authorize: AuthorizationCallbacks = {
  invite: async (actor, role, context) =>
    invitableRoles.includes(role) && isAdmittedOwner(actor.id, context?.trx),
  manageInvitation: async (actor, _invitation, context) => isAdmittedOwner(actor.id, context?.trx),
  listInvitations: async (actor, context) => isAdmittedOwner(actor.id, context?.trx),
}

/** The list callback checks the owner role; the route's `admittedAccount()` gate checks admission. */
export const admissionAuthorize: AdmissionAuthorizeCallbacks = {
  decide: async (actor, _subject, context) => isOwner(actor.id, context?.trx),
  list: async (actor, context) => isOwner(actor.id, context?.trx),
}

/** Grants the invited role inside the acceptance transaction. */
export async function onInvitationAccepted(user: AccountUser, invitation: Invitation, trx: Trx) {
  await trx.table('role_assignments').insert({ user_id: user.id, role: invitation.role })
}
