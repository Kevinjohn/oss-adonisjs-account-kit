import { DateTime } from 'luxon'
import { sqlTimestamp } from './timestamps.js'
import { randomUUID } from 'node:crypto'
import { lockRow, transaction } from './db.js'
import { finishCommitted, lifecycle, postCommit, settleCommitted } from './effects.js'
import {
  AuthorizationError,
  InvalidInputError,
  InvitationNotFoundError,
  InvitationManagementDeniedError,
} from './errors.js'
import { throttlerOf } from './throttle.js'
import { toInvitation } from './invitation_rows.js'
import { requireUser } from './actor_confirmation.js'
import { generateToken, hashToken } from './tokens.js'
import { expiresAt } from './ttl.js'
import { decodeInvitationCursor, encodeInvitationCursor } from './invitation_cursor.js'
import type {
  Invitation,
  InvitationPage,
  AccountUser,
  InvitationsListInput,
  InvitationsResendInput,
  InvitationsRevokeInput,
  ResolvedConfig,
  Trx,
} from './types.js'
import type { ServiceDependencies } from './service_dependencies.js'

function requireInvitationId(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0)
    throw new InvalidInputError('Invalid invitation id')
}

/** Lock an invitation row and check the actor may manage it. */
async function lockManagedInvitation(
  config: ResolvedConfig,
  trx: Trx,
  actor: AccountUser,
  invitationId: number
): Promise<Invitation> {
  await lockRow(trx, 'account_invitations', invitationId)
  const row = await trx.from('account_invitations').where('id', invitationId).forUpdate().first()
  if (!row) throw new InvitationNotFoundError()
  const invitation = toInvitation(row)
  if ((await config.authorize.manageInvitation(actor, invitation, { trx })) !== true)
    throw new InvitationManagementDeniedError()
  return invitation
}

/** Lock an invitation the actor may manage and may still invite to its role. */
async function lockResendable(
  config: ResolvedConfig,
  trx: Trx,
  actor: AccountUser,
  invitationId: number
): Promise<Invitation> {
  const current = await lockManagedInvitation(config, trx, actor, invitationId)
  if ((await config.authorize.invite(actor, current.role, { trx })) !== true)
    throw new InvitationManagementDeniedError()
  return current
}

export async function resendInvitation(
  deps: ServiceDependencies,
  input: InvitationsResendInput
): Promise<Invitation> {
  requireInvitationId(input.invitationId)
  const actor = await requireUser(deps.config, input.actorId)
  const token = generateToken(deps.config.tokenSecretLength)
  const operationId = randomUUID()
  // Both policy reads receive a transaction. The first commits before the limiter touches its
  // store; the second protects the row through rotation and catches intervening policy changes.
  const preflight = await transaction(deps.db, (trx) =>
    lockResendable(deps.config, trx, actor, input.invitationId)
  )
  await throttlerOf(deps).consume(
    'invitation:resend:actor',
    String(actor.id),
    deps.config.invitationThrottle.resendActor
  )
  await throttlerOf(deps).consume(
    'invitation:resend:invitation',
    String(preflight.id),
    deps.config.invitationThrottle.resendInvitation
  )
  const { value: invitation, fault } = await settleCommitted(
    transaction(deps.db, async (trx) => {
      await lockResendable(deps.config, trx, actor, input.invitationId)

      const now = DateTime.utc()
      await trx
        .from('account_invitations')
        .where('id', input.invitationId)
        .update({
          token_hash: hashToken(token),
          expires_at: sqlTimestamp(trx, expiresAt(now, deps.config.expiresIn.invitation)),
          updated_at: sqlTimestamp(trx, now),
        })
      // Re-read rather than use RETURNING, which MySQL lacks.
      const updated = await trx.from('account_invitations').where('id', input.invitationId).first()
      if (!updated) throw new InvitationNotFoundError()
      return toInvitation(updated)
    })
  )

  await finishCommitted(fault, 'Invitation rotated but follow-ups failed', () =>
    postCommit('Invitation follow-up failed', [
      {
        kind: 'delivery',
        run: () =>
          deps.config.notify.invitationProvision(invitation, deps.config.urls.invitation(token)),
      },
      lifecycle(deps.config, {
        type: 'invitation.resent',
        invitationId: invitation.id,
        operationId,
      }),
    ])
  )
  return invitation
}

export async function revokeInvitation(
  deps: Pick<ServiceDependencies, 'config' | 'db'>,
  input: InvitationsRevokeInput
): Promise<void> {
  requireInvitationId(input.invitationId)
  const actor = await requireUser(deps.config, input.actorId)
  const operationId = randomUUID()
  const { fault } = await settleCommitted(
    transaction(deps.db, async (trx) => {
      await lockManagedInvitation(deps.config, trx, actor, input.invitationId)
      await trx.from('account_invitations').where('id', input.invitationId).delete()
    })
  )
  await finishCommitted(fault, 'Invitation revoked but follow-ups failed', () =>
    postCommit('Invitation follow-up failed', [
      lifecycle(deps.config, {
        type: 'invitation.revoked',
        invitationId: input.invitationId,
        operationId,
      }),
    ])
  )
}

export async function listInvitations(
  deps: Pick<ServiceDependencies, 'config' | 'db'>,
  input: InvitationsListInput
): Promise<InvitationPage> {
  const limit = input.limit ?? 25
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new InvalidInputError('Invalid invitation page limit')
  const position = input.cursor === undefined ? null : decodeInvitationCursor(input.cursor)
  const actor = await requireUser(deps.config, input.actorId)
  if ((await deps.config.authorize.listInvitations(actor)) !== true) throw new AuthorizationError()
  const query = deps.db
    .from('account_invitations')
    .where('expires_at', '>', sqlTimestamp(deps.db))
    .orderBy('created_at', 'asc')
    .orderBy('id', 'asc')
    .limit(limit + 1)
  if (position)
    query.where((builder) =>
      builder
        .where('created_at', '>', position!.createdAt)
        .orWhere((nested) =>
          nested.where('created_at', position!.createdAt).where('id', '>', position!.id)
        )
    )
  const rows = await query
  const items = rows.slice(0, limit).map(toInvitation)
  const last = rows.length > limit ? rows[limit - 1] : null
  return {
    items,
    nextCursor: last ? encodeInvitationCursor(last.created_at, last.id) : null,
  }
}
