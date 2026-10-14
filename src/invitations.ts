import { DateTime } from 'luxon'
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
import { postCommit } from './effects.js'
import { isEmailShaped, normaliseEmail } from './email.js'
import {
  AuthorizationError,
  EmailAlreadyRegisteredError,
  InvalidInputError,
  InvitationPendingError,
  InvitationNotFoundError,
  InvitationManagementDeniedError,
  InvalidTokenError,
} from './errors.js'
import { consume } from './throttle.js'
import { isPasswordShaped } from './password.js'
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
  deps: { config: ResolvedConfig; db: Database; limiter: LimiterService },
  input: InvitationsResendInput
): Promise<Invitation> {
  requireInvitationId(input.invitationId)
  const actor = await requireActor(deps.config, input.actorId)
  const token = generateToken()
  const operationId = randomUUID()
  // Both policy reads receive a transaction. The first commits before the limiter touches its
  // store; the second protects the row through rotation and catches intervening policy changes.
  const preflight = await transaction(deps.db, async (trx) => {
    const current = await lockManagedInvitation(deps.config, trx, actor, input.invitationId)
    if ((await deps.config.authorize.invite(actor, current.role, { trx })) !== true)
      throw new InvitationManagementDeniedError()
    return current
  })
  await consume(
    deps.limiter,
    'invitation:resend:actor',
    String(actor.id),
    deps.config.invitationThrottle.resendActor,
    deps.config.limiterSecret,
    deps.config.limiterNamespace
  )
  await consume(
    deps.limiter,
    'invitation:resend:invitation',
    String(preflight.id),
    deps.config.invitationThrottle.resendInvitation,
    deps.config.limiterSecret,
    deps.config.limiterNamespace
  )
  const invitation = await transaction(deps.db, async (trx) => {
    const current = await lockManagedInvitation(deps.config, trx, actor, input.invitationId)
    if ((await deps.config.authorize.invite(actor, current.role, { trx })) !== true)
      throw new InvitationManagementDeniedError()

    const now = DateTime.utc()
    const [updated] = await trx
      .getWriteClient()
      .table('account_invitations')
      .where('id', input.invitationId)
      .update({
        token_hash: hashToken(token),
        expires_at: expiresAt(now, deps.config.ttl.invitation).toISO(),
        updated_at: now.toISO(),
      })
      .returning('*')
    if (!updated) throw new InvitationNotFoundError()
    return toInvitation(updated)
  })

  await postCommit('Invitation follow-up failed', [
    {
      kind: 'delivery',
      run: () => deps.config.notify.invitation(invitation, deps.config.urls.invitation(token)),
    },
    {
      kind: 'observer',
      run: () =>
        deps.config.onLifecycleEvent?.({
          type: 'invitation.resent',
          invitationId: invitation.id,
          operationId,
        }),
    },
  ])
  return invitation
}

export async function revokeInvitation(
  deps: { config: ResolvedConfig; db: Database },
  input: InvitationsRevokeInput
): Promise<void> {
  requireInvitationId(input.invitationId)
  const actor = await requireActor(deps.config, input.actorId)
  const operationId = randomUUID()
  await transaction(deps.db, async (trx) => {
    await lockManagedInvitation(deps.config, trx, actor, input.invitationId)
    await trx.from('account_invitations').where('id', input.invitationId).delete()
  })
  await postCommit('Invitation follow-up failed', [
    {
      kind: 'observer',
      run: () =>
        deps.config.onLifecycleEvent?.({
          type: 'invitation.revoked',
          invitationId: input.invitationId,
          operationId,
        }),
    },
  ])
}

export async function acceptInvitation(
  deps: { config: ResolvedConfig; db: Database },
  input: InvitationsAcceptInput
): Promise<AccountUser> {
  if (!isPasswordShaped(input.password)) throw new InvalidInputError('Invalid password')
  if (!isTokenShaped(input.token)) throw new InvalidTokenError()
  const operationId = randomUUID()

  try {
    const result = await transaction(deps.db, async (trx) => {
      const now = DateTime.utc()
      const row = await consumeToken<InvitationDatabaseRow>(
        trx,
        'account_invitations',
        hashToken(input.token),
        now.toISO()
      )
      if (!row) throw new InvalidTokenError()
      if (await deps.config.users.findByEmail(row.email, trx))
        throw new EmailAlreadyRegisteredError()

      const user = await deps.config.users.create(
        {
          email: row.email,
          password: input.password,
          emailVerifiedAt: now,
          registrationData: input.registrationData,
        },
        trx
      )
      await deps.config.onInvitationAccepted(user, toInvitation(row), trx)
      const reloaded = await deps.config.users.findById(user.id, trx)
      if (!reloaded) throw new InvalidTokenError()
      return { user: reloaded, invitationId: row.id }
    })
    await postCommit('Invitation follow-up failed', [
      {
        kind: 'observer',
        run: () =>
          deps.config.onLifecycleEvent?.({
            type: 'invitation.accepted',
            invitationId: result.invitationId,
            userId: result.user.id,
            operationId,
          }),
      },
    ])
    return result.user
  } catch (error) {
    if (await isUserEmailUniqueViolation(error, deps.config, deps.db))
      throw new EmailAlreadyRegisteredError()
    throw error
  }
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
    .where('expires_at', '>', DateTime.utc().toISO())
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
    .where('expires_at', '>', DateTime.utc().toISO())
    .first()
  return row ? { email: row.email, role: row.role } : null
}

export async function sendInvitation(
  deps: { config: ResolvedConfig; db: Database; limiter: LimiterService },
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
  await consume(
    deps.limiter,
    'invitation:send:actor',
    String(actor.id),
    deps.config.invitationThrottle.sendActor,
    deps.config.limiterSecret,
    deps.config.limiterNamespace
  )
  await consume(
    deps.limiter,
    'invitation:send:recipient',
    email,
    deps.config.invitationThrottle.sendRecipient,
    deps.config.limiterSecret,
    deps.config.limiterNamespace
  )

  const token = generateToken()
  const operationId = randomUUID()
  let invitation: Invitation
  try {
    invitation = await transaction(deps.db, async (trx) => {
      const now = DateTime.utc()
      await trx
        .from('account_invitations')
        .where('email', email)
        .where('expires_at', '<=', now.toISO())
        .delete()
      const [row] = await trx
        .getWriteClient()
        .table('account_invitations')
        .insert({
          email,
          role: input.role,
          inviter_id: actor.id,
          token_hash: hashToken(token),
          expires_at: expiresAt(now, deps.config.ttl.invitation).toISO(),
          created_at: now.toISO(),
          updated_at: now.toISO(),
        })
        .returning('*')
      return toInvitation(row)
    })
  } catch (error) {
    if (isUniqueViolation(error, 'account_invitations', 'email')) throw new InvitationPendingError()
    throw error
  }

  await postCommit('Invitation follow-up failed', [
    {
      kind: 'delivery',
      run: () => deps.config.notify.invitation(invitation, deps.config.urls.invitation(token)),
    },
    {
      kind: 'observer',
      run: () =>
        deps.config.onLifecycleEvent?.({
          type: 'invitation.sent',
          invitationId: invitation.id,
          operationId,
        }),
    },
  ])
  return invitation
}
