import { DateTime } from 'luxon'
import { readIsoTimestamp, sqlTimestamp } from './timestamps.js'
import { randomUUID } from 'node:crypto'
import { lockRow, lockUser, transaction } from './db.js'
import { finishCommitted, createLifecycleEffect, postCommit, settleCommitted } from './effects.js'
import {
  E_ACCOUNT_KIT_EMAIL_ALREADY_REGISTERED,
  E_ACCOUNT_KIT_AUTHORIZATION,
  E_ACCOUNT_KIT_INVALID_INPUT,
  E_ACCOUNT_KIT_INVITATION_NOT_FOUND,
  E_ACCOUNT_KIT_INVITATION_MANAGEMENT_DENIED,
} from './errors.js'
import { invitationPageSize } from './invitation_input.js'
import { toInvitation } from './invitation_rows.js'
import { normalizeScope, encodeScopeColumn } from './invitation_scope.js'
import { requireUser } from './actor_confirmation.js'
import { generateToken, hashToken } from './tokens.js'
import { expiresAt } from './ttl.js'
import { decodeKeysetCursor, encodeKeysetCursor } from './keyset_cursor.js'
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
    throw new E_ACCOUNT_KIT_INVALID_INPUT('Invalid invitation id')
}

/** Lock an invitation row and check the actor may manage it. */
async function lockManagedInvitation(
  config: ResolvedConfig,
  trx: Trx,
  actorId: AccountUser['id'],
  invitationId: number
): Promise<{ actor: AccountUser; invitation: Invitation }> {
  await lockUser(trx, config, actorId)
  const actor = await requireUser(config, actorId, trx)
  await lockRow(trx, 'account_invitations', invitationId)
  const row = await trx.from('account_invitations').where('id', invitationId).forUpdate().first()
  if (!row) throw new E_ACCOUNT_KIT_INVITATION_NOT_FOUND()
  const invitation = toInvitation(row)
  if ((await config.authorize.manageInvitation(actor, invitation, { trx })) !== true)
    throw new E_ACCOUNT_KIT_INVITATION_MANAGEMENT_DENIED()
  return { actor, invitation }
}

/** Lock an invitation the actor may manage and may still invite to its role. */
async function lockResendable(
  config: ResolvedConfig,
  trx: Trx,
  actorId: AccountUser['id'],
  invitationId: number
): Promise<Invitation> {
  const { actor, invitation: current } = await lockManagedInvitation(
    config,
    trx,
    actorId,
    invitationId
  )
  if ((await config.authorize.invite(actor, current.role, { trx, scope: current.scope })) !== true)
    throw new E_ACCOUNT_KIT_INVITATION_MANAGEMENT_DENIED()
  return current
}

/** @throws {AggregateError} Work and cleanup both failed. The work failure is first. */
export async function resendInvitation(
  deps: ServiceDependencies,
  input: InvitationsResendInput
): Promise<Invitation> {
  requireInvitationId(input.invitationId)
  await requireUser(deps.config, input.actorId)
  const token = generateToken(deps.config.tokenSecretLength)
  const operationId = randomUUID()
  // Both permission reads receive a transaction. The first commits before the limiter touches its
  // store; the second protects the row through rotation and catches intervening permission changes.
  const preflight = await transaction(deps.db, (trx) =>
    lockResendable(deps.config, trx, input.actorId, input.invitationId)
  )
  await deps.throttler.consume(
    'invitation:resend:actor',
    String(input.actorId),
    deps.config.invitationThrottle.resendActor
  )
  await deps.throttler.consume(
    'invitation:resend:invitation',
    String(preflight.id),
    deps.config.invitationThrottle.resendInvitation
  )
  const { value: invitation, fault } = await settleCommitted(
    transaction(deps.db, async (trx) => {
      const current = await lockResendable(deps.config, trx, input.actorId, input.invitationId)
      // The address may have signed up since; acceptance would refuse the new link.
      if (await deps.config.users.findByEmail(current.email, trx))
        throw new E_ACCOUNT_KIT_EMAIL_ALREADY_REGISTERED()

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
      if (!updated) throw new E_ACCOUNT_KIT_INVITATION_NOT_FOUND()
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
      createLifecycleEffect(deps.config, {
        type: 'invitation.resent',
        invitationId: invitation.id,
        operationId,
      }),
    ])
  )
  return invitation
}

/** @throws {AggregateError} Work and cleanup both failed. The work failure is first. */
export async function revokeInvitation(
  deps: Pick<ServiceDependencies, 'config' | 'db'>,
  input: InvitationsRevokeInput
): Promise<void> {
  requireInvitationId(input.invitationId)
  await requireUser(deps.config, input.actorId)
  const operationId = randomUUID()
  const { fault } = await settleCommitted(
    transaction(deps.db, async (trx) => {
      await lockManagedInvitation(deps.config, trx, input.actorId, input.invitationId)
      await trx.from('account_invitations').where('id', input.invitationId).delete()
    })
  )
  await finishCommitted(fault, 'Invitation revoked but follow-ups failed', () =>
    postCommit('Invitation follow-up failed', [
      createLifecycleEffect(deps.config, {
        type: 'invitation.revoked',
        invitationId: input.invitationId,
        operationId,
      }),
    ])
  )
}

export async function paginateInvitations(
  deps: Pick<ServiceDependencies, 'config' | 'db'>,
  input: InvitationsListInput
): Promise<InvitationPage> {
  const limit = input.limit ?? invitationPageSize.default
  if (
    !Number.isInteger(limit) ||
    limit < invitationPageSize.minimum ||
    limit > invitationPageSize.maximum
  )
    throw new E_ACCOUNT_KIT_INVALID_INPUT('Invalid invitation page limit')
  const position =
    input.cursor === undefined
      ? null
      : decodeKeysetCursor(input.cursor, 'Invalid invitation cursor')
  const scope = input.scope === undefined ? undefined : normalizeScope(input.scope)
  const actor = await requireUser(deps.config, input.actorId)
  const context = scope === undefined ? {} : { scope }
  if ((await deps.config.authorize.listInvitations(actor, context)) !== true)
    throw new E_ACCOUNT_KIT_AUTHORIZATION()
  const query = deps.db.from('account_invitations').where('expires_at', '>', sqlTimestamp(deps.db))
  if (scope !== undefined) query.where('scope', encodeScopeColumn(scope))
  query
    .orderBy('created_at', 'asc')
    .orderBy('id', 'asc')
    .limit(limit + 1)
  if (position) {
    // The cursor carries ISO 8601 UTC; compare in the form this engine stores.
    const createdAt = sqlTimestamp(deps.db, DateTime.fromISO(position.createdAt, { zone: 'utc' }))
    query.where((builder) =>
      builder
        .where('created_at', '>', createdAt)
        .orWhere((nested) => nested.where('created_at', createdAt).where('id', '>', position.id))
    )
  }
  const rows = await query
  const items = rows.slice(0, limit).map(toInvitation)
  const last = rows.length > limit ? rows[limit - 1] : null
  return {
    items,
    // The driver may return a Date or an SQL string; the cursor always carries ISO 8601 UTC.
    nextCursor: last ? encodeKeysetCursor(readIsoTimestamp(last.created_at), last.id) : null,
  }
}
