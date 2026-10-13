import { DateTime } from 'luxon'
import type { Database } from '@adonisjs/lucid/database'
import { transaction, isUniqueViolation } from './db.js'
import { isEmailShaped, normaliseEmail } from './email.js'
import {
  AuthorizationError,
  DeliveryError,
  EmailAlreadyRegisteredError,
  InvalidInputError,
  InvitationPendingError,
} from './errors.js'
import { toInvitation } from './rows.js'
import { generateToken, hashToken } from './tokens.js'
import { expiresAt } from './ttl.js'
import type { Invitation, InvitationsSendInput, ResolvedConfig } from './types.js'

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
