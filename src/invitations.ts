import { DateTime } from 'luxon'
import { sqlTimestamp } from './timestamps.js'
import { randomUUID } from 'node:crypto'
import type { Database } from '@adonisjs/lucid/database'
import type { LimiterService } from '@adonisjs/limiter/types'
import {
  consumeToken,
  lockRow,
  transaction,
  isUniqueViolation,
  isUserEmailUniqueViolation,
} from './db.js'
import { finishCommitted, lifecycle, postCommit, settleCommitted } from './effects.js'
import { isEmailShaped, normaliseEmail } from './email.js'
import {
  AuthorizationError,
  EmailAlreadyRegisteredError,
  InvalidInputError,
  InvitationPendingError,
  InvitationNotFoundError,
  InvitationManagementDeniedError,
  InvalidTokenError,
  type PostCommitError,
} from './errors.js'
import { throttlerOf, type Throttler } from './throttle.js'
import { isPasswordAllowed } from './password.js'
import { mapRegistrationFields } from './registration_fields.js'
import { toInvitation, type InvitationDatabaseRow } from './rows.js'
import { generateToken, hashToken, isTokenShaped } from './tokens.js'
import { expiresAt } from './ttl.js'
import type {
  Invitation,
  InvitationPage,
  AccountUser,
  InvitationsAcceptInput,
  InvitationsInspectInput,
  InvitationsListInput,
  InvitationsResendInput,
  InvitationsRevokeInput,
  InvitationsSendInput,
  ResolvedConfig,
  Trx,
  UserId,
} from './types.js'

const MAX_INVITATION_CURSOR_LENGTH = 512

async function requireActor(config: ResolvedConfig, actorId: UserId): Promise<AccountUser> {
  const actor = await config.users.findById(actorId)
  if (!actor) throw new InvalidInputError('Unknown actor')
  return actor
}

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

export async function resendInvitation(
  deps: { config: ResolvedConfig; db: Database; limiter: LimiterService; throttler?: Throttler },
  input: InvitationsResendInput
): Promise<Invitation> {
  requireInvitationId(input.invitationId)
  const actor = await requireActor(deps.config, input.actorId)
  const token = generateToken(deps.config.tokenSecretLength)
  const operationId = randomUUID()
  // Both policy reads receive a transaction. The first commits before the limiter touches its
  // store; the second protects the row through rotation and catches intervening policy changes.
  const preflight = await transaction(deps.db, async (trx) => {
    const current = await lockManagedInvitation(deps.config, trx, actor, input.invitationId)
    if ((await deps.config.authorize.invite(actor, current.role, { trx })) !== true)
      throw new InvitationManagementDeniedError()
    return current
  })
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
      const current = await lockManagedInvitation(deps.config, trx, actor, input.invitationId)
      if ((await deps.config.authorize.invite(actor, current.role, { trx })) !== true)
        throw new InvitationManagementDeniedError()

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
  deps: { config: ResolvedConfig; db: Database },
  input: InvitationsRevokeInput
): Promise<void> {
  requireInvitationId(input.invitationId)
  const actor = await requireActor(deps.config, input.actorId)
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

export async function acceptInvitation(
  deps: { config: ResolvedConfig; db: Database },
  input: InvitationsAcceptInput
): Promise<AccountUser> {
  if (!isPasswordAllowed(input.password, deps.config.passwordPolicy))
    throw new InvalidInputError('Invalid password')
  if (!isTokenShaped(input.token)) throw new InvalidTokenError()
  const registrationData = await mapRegistrationFields(deps.config, input.registrationData)
  const operationId = randomUUID()

  let result: { user: AccountUser; invitationId: number }
  let fault: PostCommitError | undefined
  try {
    ;({ value: result, fault } = await settleCommitted(
      transaction(deps.db, async (trx) => {
        const now = DateTime.utc()
        const row = await consumeToken<InvitationDatabaseRow>(
          trx,
          'account_invitations',
          hashToken(input.token),
          sqlTimestamp(trx, now)
        )
        if (!row) throw new InvalidTokenError()
        if (await deps.config.users.findByEmail(row.email, trx))
          throw new EmailAlreadyRegisteredError()

        const user = await deps.config.users.create(
          {
            email: row.email,
            unverifiedEmail: null,
            password: input.password,
            registrationData,
          },
          trx
        )
        await deps.config.users.markEmailVerified(user.id, now, trx)
        const reloaded = await deps.config.users.findById(user.id, trx)
        if (!reloaded) throw new InvalidTokenError()
        await deps.config.onInvitationAccepted(reloaded, toInvitation(row), trx)
        const accepted = await deps.config.users.findById(user.id, trx)
        if (!accepted) throw new InvalidTokenError()
        return { user: accepted, invitationId: row.id }
      })
    ))
  } catch (error) {
    if (await isUserEmailUniqueViolation(error, deps.config, deps.db))
      throw new EmailAlreadyRegisteredError()
    throw error
  }
  await finishCommitted(fault, 'Invitation committed but follow-ups failed', () =>
    postCommit('Invitation follow-up failed', [
      lifecycle(deps.config, {
        type: 'invitation.accepted',
        invitationId: result.invitationId,
        userId: result.user.id,
        operationId,
      }),
    ])
  )
  return result.user
}

export async function listInvitations(
  deps: { config: ResolvedConfig; db: Database },
  input: InvitationsListInput
): Promise<InvitationPage> {
  const limit = input.limit ?? 25
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new InvalidInputError('Invalid invitation page limit')
  let position: { createdAt: string; id: number } | null = null
  if (input.cursor !== undefined) {
    try {
      if (input.cursor.length > MAX_INVITATION_CURSOR_LENGTH) throw new Error('invalid')
      const decoded = JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8'))
      if (
        !Array.isArray(decoded) ||
        decoded.length !== 2 ||
        typeof decoded[0] !== 'string' ||
        !DateTime.fromISO(decoded[0], { setZone: true }).isValid ||
        !Number.isSafeInteger(decoded[1]) ||
        decoded[1] < 1 ||
        Buffer.from(JSON.stringify(decoded)).toString('base64url') !== input.cursor
      )
        throw new Error('invalid')
      position = { createdAt: decoded[0], id: decoded[1] }
    } catch {
      throw new InvalidInputError('Invalid invitation cursor')
    }
  }
  const actor = await requireActor(deps.config, input.actorId)
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
    nextCursor: last
      ? Buffer.from(JSON.stringify([last.created_at, last.id])).toString('base64url')
      : null,
  }
}

export async function inspectInvitation(
  db: Database,
  input: InvitationsInspectInput
): Promise<Pick<Invitation, 'email' | 'role'> | null> {
  if (!isTokenShaped(input.token)) return null
  const row = await db
    .from('account_invitations')
    .select('email', 'role')
    .where('token_hash', hashToken(input.token))
    .where('expires_at', '>', sqlTimestamp(db))
    .first()
  return row ? { email: row.email, role: row.role } : null
}

export async function sendInvitation(
  deps: { config: ResolvedConfig; db: Database; limiter: LimiterService; throttler?: Throttler },
  input: InvitationsSendInput
): Promise<Invitation> {
  if (!isEmailShaped(input.email)) throw new InvalidInputError('Invalid email')
  if (typeof input.role !== 'string' || input.role.length < 1 || input.role.length > 64)
    throw new InvalidInputError('Invalid role')
  const email = normaliseEmail(input.email)
  const actor = await requireActor(deps.config, input.actorId)
  if ((await deps.config.authorize.invite(actor, input.role)) !== true)
    throw new AuthorizationError()
  if (await deps.config.users.findByEmail(email)) throw new EmailAlreadyRegisteredError()
  await throttlerOf(deps).consume(
    'invitation:send:actor',
    String(actor.id),
    deps.config.invitationThrottle.sendActor
  )
  await throttlerOf(deps).consume(
    'invitation:send:recipient',
    email,
    deps.config.invitationThrottle.sendRecipient
  )

  const token = generateToken(deps.config.tokenSecretLength)
  const operationId = randomUUID()
  const { invitation, fault } = await storeInvitation(deps, {
    email,
    role: input.role,
    inviterId: actor.id,
    token,
    replacePending: false,
  })

  await finishCommitted(fault, 'Invitation committed but follow-ups failed', () =>
    postCommit('Invitation follow-up failed', [
      {
        kind: 'delivery',
        run: () =>
          deps.config.notify.invitationProvision(invitation, deps.config.urls.invitation(token)),
      },
      lifecycle(deps.config, {
        type: 'invitation.sent',
        invitationId: invitation.id,
        operationId,
      }),
    ])
  )
  return invitation
}

/**
 * Insert an invitation row for a normalised email. Expired rows for the address are removed first;
 * `replacePending` also removes a live one (operator reissue). Shared by the actor and operator
 * paths; a pending invitation otherwise surfaces as InvitationPendingError.
 */
export async function storeInvitation(
  deps: { config: ResolvedConfig; db: Database },
  input: {
    email: string
    role: string
    inviterId: UserId | null
    token: string
    replacePending: boolean
  }
): Promise<{ invitation: Invitation; fault?: PostCommitError }> {
  try {
    return await settleCommitted(
      transaction(deps.db, async (trx) => {
        const now = DateTime.utc()
        const stale = trx.from('account_invitations').where('email', input.email)
        if (!input.replacePending) stale.where('expires_at', '<=', sqlTimestamp(trx, now))
        await stale.delete()
        await trx.table('account_invitations').insert({
          email: input.email,
          role: input.role,
          inviter_id: input.inviterId,
          token_hash: hashToken(input.token),
          expires_at: sqlTimestamp(trx, expiresAt(now, deps.config.expiresIn.invitation)),
          created_at: sqlTimestamp(trx, now),
          updated_at: sqlTimestamp(trx, now),
        })
        // Email is unique; re-read rather than use RETURNING, which MySQL lacks.
        const row = await trx.from('account_invitations').where('email', input.email).first()
        return toInvitation(row)
      })
    ).then(({ value, fault }) => ({ invitation: value, fault }))
  } catch (error) {
    if (isUniqueViolation(error, 'account_invitations', 'email')) throw new InvitationPendingError()
    throw error
  }
}
