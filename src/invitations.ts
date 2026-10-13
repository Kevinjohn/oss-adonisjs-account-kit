import { DateTime } from 'luxon'
import type { Database } from '@adonisjs/lucid/database'
import { consumeInvitationToken, transaction, isUniqueViolation } from './db.js'
import { isEmailShaped, normaliseEmail } from './email.js'
import {
  AuthorizationError,
  DeliveryError,
  EmailAlreadyRegisteredError,
  InvalidInputError,
  InvitationPendingError,
  InvalidTokenError,
} from './errors.js'
import { toInvitation } from './rows.js'
import { generateToken, hashToken, isTokenShaped } from './tokens.js'
import { expiresAt } from './ttl.js'
import type {
  Invitation,
  AccountUser,
  InvitationsAcceptInput,
  InvitationsInspectInput,
  InvitationsListInput,
  InvitationsSendInput,
  ResolvedConfig,
} from './types.js'

export async function acceptInvitation(
  deps: { config: ResolvedConfig; db: Database },
  input: InvitationsAcceptInput
): Promise<AccountUser> {
  if (
    typeof input.password !== 'string' ||
    input.password.length < 8 ||
    input.password.length > 255
  )
    throw new InvalidInputError('Invalid password')
  if (!isTokenShaped(input.token)) throw new InvalidTokenError()

  try {
    return await transaction(deps.db, async (trx) => {
      const now = DateTime.utc()
      const row = await consumeInvitationToken(trx, hashToken(input.token), now.toISO())
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
    if (isUniqueViolation(error, 'users', 'email')) throw new EmailAlreadyRegisteredError()
    throw error
  }
}

export async function listInvitations(
  deps: { config: ResolvedConfig; db: Database },
  input: InvitationsListInput
): Promise<Invitation[]> {
  const actor = await deps.config.users.findById(input.actorId)
  if (!actor) throw new InvalidInputError('Unknown actor')
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
  const actor = await deps.config.users.findById(input.actorId)
  if (!actor) throw new InvalidInputError('Unknown actor')
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

  try {
    await deps.config.notify.invitation(invitation, deps.config.urls.invitation(token))
  } catch (cause) {
    throw new DeliveryError('Invitation notification failed', { cause })
  }
  return invitation
}
