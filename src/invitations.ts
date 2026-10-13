import { DateTime } from 'luxon'
import type { Database } from '@adonisjs/lucid/database'
import { consumeToken, lockRow, transaction, isUniqueViolation } from './db.js'
import { deliver } from './effects.js'
import { isEmailShaped, normaliseEmail } from './email.js'
import {
  AuthorizationError,
  EmailAlreadyRegisteredError,
  InvalidInputError,
  InvitationPendingError,
  InvalidTokenError,
} from './errors.js'
import { isPasswordShaped } from './password.js'
import { toInvitation, type InvitationDatabaseRow } from './rows.js'
import { generateToken, hashToken, isTokenShaped } from './tokens.js'
import { expiresAt } from './ttl.js'
import type {
  Invitation,
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

/** Lock an invitation row and check the actor may manage it. */
async function lockManagedInvitation(
  config: ResolvedConfig,
  trx: Trx,
  actor: AccountUser,
  invitationId: number
): Promise<Invitation> {
  await lockRow(trx, 'account_invitations', invitationId)
  const row = await trx.from('account_invitations').where('id', invitationId).forUpdate().first()
  if (!row) throw new InvalidTokenError()
  const invitation = toInvitation(row)
  if ((await config.authorize.manageInvitation(actor, invitation)) !== true)
    throw new AuthorizationError()
  return invitation
}

export async function resendInvitation(
  deps: { config: ResolvedConfig; db: Database },
  input: InvitationsResendInput
): Promise<Invitation> {
  const actor = await requireActor(deps.config, input.actorId)
  const token = generateToken()
  const invitation = await transaction(deps.db, async (trx) => {
    const current = await lockManagedInvitation(deps.config, trx, actor, input.invitationId)
    if ((await deps.config.authorize.invite(actor, current.role)) !== true)
      throw new AuthorizationError()

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
    if (!updated) throw new InvalidTokenError()
    return toInvitation(updated)
  })

  await deliver('Invitation notification failed', () =>
    deps.config.notify.invitation(invitation, deps.config.urls.invitation(token))
  )
  return invitation
}

export async function revokeInvitation(
  deps: { config: ResolvedConfig; db: Database },
  input: InvitationsRevokeInput
): Promise<void> {
  const actor = await requireActor(deps.config, input.actorId)
  await transaction(deps.db, async (trx) => {
    await lockManagedInvitation(deps.config, trx, actor, input.invitationId)
    await trx.from('account_invitations').where('id', input.invitationId).delete()
  })
}

export async function acceptInvitation(
  deps: { config: ResolvedConfig; db: Database },
  input: InvitationsAcceptInput
): Promise<AccountUser> {
  if (!isPasswordShaped(input.password)) throw new InvalidInputError('Invalid password')
  if (!isTokenShaped(input.token)) throw new InvalidTokenError()

  try {
    return await transaction(deps.db, async (trx) => {
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
        { email: row.email, password: input.password, emailVerifiedAt: now },
        trx
      )
      await deps.config.onInvitationAccepted(user, toInvitation(row), trx)
      const reloaded = await deps.config.users.findById(user.id, trx)
      if (!reloaded) throw new InvalidTokenError()
      return reloaded
    })
  } catch (error) {
    if (isUniqueViolation(error, deps.config.usersTable, 'email'))
      throw new EmailAlreadyRegisteredError()
    throw error
  }
}

export async function listInvitations(
  deps: { config: ResolvedConfig; db: Database },
  input: InvitationsListInput
): Promise<Invitation[]> {
  const actor = await requireActor(deps.config, input.actorId)
  if ((await deps.config.authorize.listInvitations(actor)) !== true) throw new AuthorizationError()
  const rows = await deps.db
    .from('account_invitations')
    .where('expires_at', '>', DateTime.utc().toISO())
    .orderBy('created_at', 'asc')
  return rows.map(toInvitation)
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
  deps: { config: ResolvedConfig; db: Database },
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

  const token = generateToken()
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

  await deliver('Invitation notification failed', () =>
    deps.config.notify.invitation(invitation, deps.config.urls.invitation(token))
  )
  return invitation
}
