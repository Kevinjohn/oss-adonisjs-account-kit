// Consumes the pending invitation for an address core has just confirmed, as the emailed link would.
import type { DateTime } from 'luxon'
import { consumeRows } from './consume_rows.js'
import { lifecycle, type PostCommitEffect } from './effects.js'
import { normalizeEmail } from './email.js'
import { InvalidTokenError } from './errors.js'
import { toInvitation, type InvitationDatabaseRow } from './invitation_rows.js'
import { sqlTimestamp } from './timestamps.js'
import type { AccountUser, ResolvedConfig, Trx, UserId } from './types.js'

/**
 * When `user.email` holds an unused, unexpired invitation, delete it and run
 * `onInvitationAccepted` inside `trx`, and return the invitation id; otherwise return null and
 * change nothing. Call it only where core has just confirmed control of the address: a new social
 * account with a provider-verified address, and account activation.
 */
export async function matchInvitation(
  config: Pick<ResolvedConfig, 'enabled' | 'users' | 'onInvitationAccepted'>,
  trx: Trx,
  user: AccountUser,
  now: DateTime
): Promise<number | null> {
  if (!config.enabled.includes('invitations')) return null
  const [row] = await consumeRows<InvitationDatabaseRow>(
    trx,
    'account_invitations',
    { email: normalizeEmail(user.email) },
    sqlTimestamp(trx, now)
  )
  if (!row) return null
  const accepted = await config.users.findById(user.id, trx)
  if (!accepted) throw new InvalidTokenError()
  await config.onInvitationAccepted(accepted, toInvitation(row), trx)
  return row.id
}

/** The `invitation.accepted` lifecycle effect for a matched invitation, or none. */
export function invitationAccepted(
  config: Pick<ResolvedConfig, 'onLifecycleEvent'>,
  invitationId: number | null,
  userId: UserId,
  operationId: string
): PostCommitEffect[] {
  if (invitationId === null) return []
  return [lifecycle(config, { type: 'invitation.accepted', invitationId, userId, operationId })]
}
