import { DateTime } from 'luxon'
import { sqlTimestamp } from './timestamps.js'
import { randomUUID } from 'node:crypto'
import type { Database } from '@adonisjs/lucid/database'
import {
  consumeToken,
  lockUser,
  transaction,
  isUniqueViolation,
  isUserEmailUniqueViolation,
} from './db.js'
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
import { isPasswordAllowed } from './password.js'
import { passwordAttributes, preparePassword } from './password_hashing.js'
import { mapRegistrationFields } from './registration_fields.js'
import { toInvitation, type InvitationDatabaseRow } from './invitation_rows.js'
import { normalizeScope, scopeColumn } from './invitation_scope.js'
import { applyInvitations, invitationAccepted } from './invitation_match.js'
import { consumeRows } from './consume_rows.js'
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

  let result: { user: AccountUser; invitationIds: number[] }
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
        // The other scopes' pending invitations for the address join the same acceptance.
        const others = await consumeRows<InvitationDatabaseRow>(
          trx,
          'account_invitations',
          { email: row.email },
          sqlTimestamp(trx, now)
        )

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
        const invitationIds = await applyInvitations(deps.config, trx, reloaded, [row, ...others])
        const accepted = await deps.config.users.findById(user.id, trx)
        if (!accepted) throw new InvalidTokenError()
        return { user: accepted, invitationIds }
      })
    ))
  } catch (error) {
    if (await isUserEmailUniqueViolation(error, deps.config, deps.db))
      throw new EmailAlreadyRegisteredError()
    throw error
  }
  await finishCommitted(fault, 'Invitation committed but follow-ups failed', () =>
    postCommit(
      'Invitation follow-up failed',
      invitationAccepted(deps.config, result.invitationIds, result.user.id, operationId)
    )
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
  const scope = normalizeScope(input.scope)
  const email = normalizeEmail(input.email)
  const actor = await requireUser(deps.config, input.actorId)
  if ((await deps.config.authorize.invite(actor, input.role, { scope })) !== true)
    throw new AuthorizationError()
  // Spend the actor's budget first: the registered-address answer below must not be free to probe.
  await deps.throttler.consume(
    'invitation:send:actor',
    String(actor.id),
    deps.config.invitationThrottle.sendActor
  )
  if (await deps.config.users.findByEmail(email)) throw new EmailAlreadyRegisteredError()
  await deps.throttler.consume(
    'invitation:send:recipient',
    email,
    deps.config.invitationThrottle.sendRecipient
  )

  const token = generateToken(deps.config.tokenSecretLength)
  const operationId = randomUUID()
  const { invitation, fault } = await storeInvitation(deps, {
    email,
    role: input.role,
    scope,
    inviterId: actor.id,
    token,
    replacePending: false,
    recheckInvite: true,
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
 * Insert an invitation row for a normalized email and scope. Expired rows for the address and
 * scope are removed first; `replacePending` also removes a live one (operator reissue). Shared by
 * the actor and operator paths; a pending invitation otherwise surfaces as InvitationPendingError.
 * `recheckInvite` locks the inviter row and runs `authorize.invite` again with `trx` and the
 * scope. Lock order: inviter, invitation, then whatever the application locks in `invite`.
 */
export async function storeInvitation(
  deps: Pick<ServiceDependencies, 'config' | 'db'>,
  input: {
    email: string
    role: string
    scope: string | null
    inviterId: UserId | null
    token: string
    replacePending: boolean
    recheckInvite?: boolean
  }
): Promise<{ invitation: Invitation; fault?: PostCommitError }> {
  try {
    return await settleCommitted(
      transaction(deps.db, async (trx) => {
        let inviter: AccountUser | null | undefined
        if (input.recheckInvite && input.inviterId !== null) {
          await lockUser(trx, deps.config, input.inviterId)
          inviter = await deps.config.users.findById(input.inviterId, trx)
          if (!inviter) throw new AuthorizationError()
        }
        const now = DateTime.utc()
        const scope = scopeColumn(input.scope)
        const stale = trx
          .from('account_invitations')
          .where('email', input.email)
          .where('scope', scope)
        if (!input.replacePending) stale.where('expires_at', '<=', sqlTimestamp(trx, now))
        await stale.delete()
        if (
          inviter &&
          (await deps.config.authorize.invite(inviter, input.role, {
            trx,
            scope: input.scope,
          })) !== true
        )
          throw new AuthorizationError()
        await trx.table('account_invitations').insert({
          email: input.email,
          role: input.role,
          scope,
          inviter_id: input.inviterId,
          token_hash: hashToken(input.token),
          expires_at: sqlTimestamp(trx, expiresAt(now, deps.config.expiresIn.invitation)),
          created_at: sqlTimestamp(trx, now),
          updated_at: sqlTimestamp(trx, now),
        })
        // Email and scope are unique together; re-read rather than use RETURNING, which MySQL lacks.
        const row = await trx
          .from('account_invitations')
          .where('email', input.email)
          .where('scope', scope)
          .first()
        return toInvitation(row)
      })
    ).then(({ value, fault }) => ({ invitation: value, fault }))
  } catch (error) {
    if (isUniqueViolation(error, 'account_invitations', ['email', 'scope']))
      throw new InvitationPendingError()
    throw error
  }
}
