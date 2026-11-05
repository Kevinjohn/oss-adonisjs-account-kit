// Consumes the pending invitations for an address core has just confirmed, as the emailed link would.
import type { DateTime } from 'luxon'
import { consumeRows } from './consume_rows.js'
import { lifecycle, type PostCommitEffect } from './effects.js'
import { normalizeEmail } from './email.js'
import { InvalidTokenError } from './errors.js'
import { toInvitation, type InvitationDatabaseRow } from './invitation_rows.js'
import { byScope } from './invitation_scope.js'
import { sqlTimestamp } from './timestamps.js'
import type { AccountUser, ResolvedConfig, Trx, UserId } from './types.js'

/**
 * Run `onInvitationAccepted(user, invitation, trx)` once per consumed row, in ascending `scope`
 * order, and return the invitation ids in that order. A throwing callback fails the whole
 * acceptance.
 */
export async function applyInvitations(
  config: Pick<ResolvedConfig, 'onInvitationAccepted'>,
  trx: Trx,
  user: AccountUser,
  rows: InvitationDatabaseRow[]
): Promise<number[]> {
  const ordered = [...rows].sort(byScope)
  for (const row of ordered) await config.onInvitationAccepted(user, toInvitation(row), trx)
  return ordered.map((row) => row.id)
}

/**
 * When `user.email` holds unused, unexpired invitations, delete them all and run
 * `onInvitationAccepted` for each inside `trx`, and return their ids; otherwise return an empty
 * list and change nothing. Call it only where core has just confirmed control of the address: a
 * new social account with a provider-verified address, account activation, and a password reset
 * that confirms a never-confirmed account.
 */
export async function matchInvitation(
  config: Pick<ResolvedConfig, 'enabled' | 'users' | 'onInvitationAccepted'>,
  trx: Trx,
  user: AccountUser,
  now: DateTime
): Promise<number[]> {
  if (!config.enabled.includes('invitations')) return []
  const rows = await consumeRows<InvitationDatabaseRow>(
    trx,
    'account_invitations',
    { email: normalizeEmail(user.email) },
    sqlTimestamp(trx, now)
  )
  if (rows.length === 0) return []
  const accepted = await config.users.findById(user.id, trx)
  if (!accepted) throw new InvalidTokenError()
  return applyInvitations(config, trx, accepted, rows)
}

/** One `invitation.accepted` lifecycle effect per accepted invitation, in acceptance order. */
export function invitationAccepted(
  config: Pick<ResolvedConfig, 'onLifecycleEvent'>,
  invitationIds: number[],
  userId: UserId,
  operationId: string
): PostCommitEffect[] {
  return invitationIds.map((invitationId) =>
    lifecycle(config, { type: 'invitation.accepted', invitationId, userId, operationId })
  )
}
