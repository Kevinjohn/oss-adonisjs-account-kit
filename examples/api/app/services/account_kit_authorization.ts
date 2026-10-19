import db from '@adonisjs/lucid/services/db'
import type { AccountUser, Invitation, Trx } from 'adonisjs-account-kit'
import type { AuthorizationCallbacks } from 'adonisjs-account-kit/types'

/** True when the user holds the owner role in the example's `role_assignments` table. */
export async function isOwner(userId: number | string, trx?: Trx): Promise<boolean> {
  const query = trx ? trx.from('role_assignments') : db.from('role_assignments')
  return Boolean(await query.where('user_id', userId).where('role', 'owner').first())
}

/** Denies access to accounts that carry the `disabled` role. */
export async function canAccess(user: AccountUser, trx: Trx): Promise<boolean> {
  return !(await trx
    .from('role_assignments')
    .where('user_id', user.id)
    .where('role', 'disabled')
    .first())
}

/** Owners may invite non-owners, and manage and list invitations. */
export const authorize: AuthorizationCallbacks = {
  invite: async (actor, role, context) => role !== 'owner' && isOwner(actor.id, context?.trx),
  manageInvitation: async (actor, _invitation, context) => isOwner(actor.id, context?.trx),
  listInvitations: async (actor) => isOwner(actor.id),
}

/** Grants the invited role inside the acceptance transaction. */
export async function onInvitationAccepted(user: AccountUser, invitation: Invitation, trx: Trx) {
  await trx.table('role_assignments').insert({ user_id: user.id, role: invitation.role })
}
