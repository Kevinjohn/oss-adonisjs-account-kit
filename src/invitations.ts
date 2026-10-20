import { DateTime } from 'luxon'
import { sqlTimestamp } from './timestamps.js'
import { randomUUID } from 'node:crypto'
import type { Database } from '@adonisjs/lucid/database'
import { consumeToken, transaction, isUniqueViolation, isUserEmailUniqueViolation } from './db.js'
import { finishCommitted, lifecycle, postCommit, settleCommitted } from './effects.js'
import { isEmailShaped, normalizeEmail } from './email.js'
import {
  AuthorizationError,
  EmailAlreadyRegisteredError,
  InvalidInputError,
  InvitationPendingError,
  InvalidTokenError,
  type PostCommitError,
} from './errors.js'
import { throttlerOf } from './throttle.js'
import { isPasswordAllowed } from './password.js'
import { passwordAttributes, preparePassword } from './password_hashing.js'
import { mapRegistrationFields } from './registration_fields.js'
import { toInvitation, type InvitationDatabaseRow } from './invitation_rows.js'
import { requireUser } from './actor_confirmation.js'
import { generateToken, hashToken, isTokenShaped } from './tokens.js'
import { expiresAt } from './ttl.js'
import type {
  Invitation,
  AccountUser,
  InvitationsAcceptInput,
  InvitationsInspectInput,
  InvitationsSendInput,
  UserId,
} from './types.js'
import type { ServiceDependencies } from './service_dependencies.js'

export { resendInvitation, revokeInvitation, listInvitations } from './invitation_management.js'

export async function acceptInvitation(
  deps: Pick<ServiceDependencies, 'config' | 'db'>,
  input: InvitationsAcceptInput
): Promise<AccountUser> {
  if (!isPasswordAllowed(input.password, deps.config.passwordPolicy))
    throw new InvalidInputError('Invalid password')
  if (!isTokenShaped(input.token)) throw new InvalidTokenError()
  const registrationData = await mapRegistrationFields(deps.config, input.registrationData)
  const operationId = randomUUID()
  const password = await preparePassword(deps.config.users, input.password)

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
            ...passwordAttributes(password),
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
  deps: ServiceDependencies,
  input: InvitationsSendInput
): Promise<Invitation> {
  if (!isEmailShaped(input.email)) throw new InvalidInputError('Invalid email')
  if (typeof input.role !== 'string' || input.role.length < 1 || input.role.length > 64)
    throw new InvalidInputError('Invalid role')
  const email = normalizeEmail(input.email)
  const actor = await requireUser(deps.config, input.actorId)
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
 * Insert an invitation row for a normalized email. Expired rows for the address are removed first;
 * `replacePending` also removes a live one (operator reissue). Shared by the actor and operator
 * paths; a pending invitation otherwise surfaces as InvitationPendingError.
 */
export async function storeInvitation(
  deps: Pick<ServiceDependencies, 'config' | 'db'>,
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
