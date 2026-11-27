import { DateTime } from 'luxon'
import { sqlTimestamp } from './timestamps.ts'
import { randomUUID } from 'node:crypto'
import type { Database } from '@adonisjs/lucid/database'
import {
  consumeToken,
  lockUser,
  transaction,
  isUniqueViolation,
  isUserEmailUniqueViolation,
} from './db.ts'
import { finishCommitted, createLifecycleEffect, postCommit, settleCommitted } from './effects.ts'
import { isInvitationRole } from './invitation_input.ts'
import { isEmailShaped, normalizeEmail } from './email.ts'
import {
  E_ACCOUNT_KIT_AUTHORIZATION,
  E_ACCOUNT_KIT_EMAIL_ALREADY_REGISTERED,
  E_ACCOUNT_KIT_INVALID_INPUT,
  E_ACCOUNT_KIT_INVITATION_PENDING,
  E_ACCOUNT_KIT_INVALID_TOKEN,
  type E_ACCOUNT_KIT_POST_COMMIT,
} from './errors.ts'
import { isPasswordAllowed } from './password.ts'
import { buildPasswordAttributes, preparePassword } from './password_hashing.ts'
import { mapRegistrationFields } from './registration_fields.ts'
import { toInvitation, type InvitationDatabaseRow } from './invitation_rows.ts'
import { normalizeScope, encodeScopeColumn } from './invitation_scope.ts'
import { applyInvitations, emitInvitationAccepted } from './invitation_match.ts'
import { consumeRows } from './consume_rows.ts'
import { requireUser } from './actor_confirmation.ts'
import { generateToken, hashToken, isTokenShaped } from './tokens.ts'
import { expiresAt } from './ttl.ts'
import type {
  Invitation,
  AccountUser,
  InvitationsAcceptInput,
  InvitationsInspectInput,
  InvitationsSendInput,
  UserId,
} from './types.ts'
import type { ServiceDependencies } from './service_dependencies.ts'

export { resendInvitation, revokeInvitation, paginateInvitations } from './invitation_management.ts'

/** @throws {AggregateError} If transaction work and cleanup fail before a commit is confirmed. */
export async function acceptInvitation(
  deps: Pick<ServiceDependencies, 'config' | 'db'>,
  input: InvitationsAcceptInput
): Promise<AccountUser> {
  if (!isPasswordAllowed(input.password, deps.config.passwordPolicy))
    throw new E_ACCOUNT_KIT_INVALID_INPUT('Invalid password')
  if (!isTokenShaped(input.token)) throw new E_ACCOUNT_KIT_INVALID_TOKEN()
  const registrationData = await mapRegistrationFields(deps.config, input.registrationData)
  const operationId = randomUUID()
  const password = await preparePassword(deps.config.users, input.password)

  let result: { user: AccountUser; invitationIds: number[] }
  let fault: InstanceType<typeof E_ACCOUNT_KIT_POST_COMMIT> | undefined
  try {
    ;({ value: result, fault } = await settleCommitted(
      transaction(deps.db, async (trx) => {
        const tokenHash = hashToken(input.token)
        const candidate = await trx
          .from('account_invitations')
          .where('token_hash', tokenHash)
          .where('expires_at', '>', sqlTimestamp(trx, DateTime.utc()))
          .select('email')
          .first()
        if (!candidate) throw new E_ACCOUNT_KIT_INVALID_TOKEN()
        if (await deps.config.users.findByEmail(candidate.email, trx))
          throw new E_ACCOUNT_KIT_EMAIL_ALREADY_REGISTERED()
        // Claim the unique user email before consuming invitation rows, matching automatic
        // invitation acceptance during social signup. A failed proof recheck rolls this back.
        const user = await deps.config.users.create(
          {
            email: candidate.email,
            unverifiedEmail: null,
            ...buildPasswordAttributes(password),
            registrationData,
          },
          trx
        )
        const now = DateTime.utc()
        const row = await consumeToken<InvitationDatabaseRow>(
          trx,
          'account_invitations',
          tokenHash,
          sqlTimestamp(trx, now)
        )
        if (!row || row.email !== candidate.email) throw new E_ACCOUNT_KIT_INVALID_TOKEN()
        // The other scopes' pending invitations for the address join the same acceptance.
        const others = await consumeRows<InvitationDatabaseRow>(
          trx,
          'account_invitations',
          { email: row.email },
          sqlTimestamp(trx, now)
        )

        await deps.config.users.markEmailVerified(user.id, now, trx)
        const reloaded = await deps.config.users.findById(user.id, trx)
        if (!reloaded) throw new E_ACCOUNT_KIT_INVALID_TOKEN()
        const invitationIds = await applyInvitations(deps.config, trx, reloaded, [row, ...others])
        const accepted = await deps.config.users.findById(user.id, trx)
        if (!accepted) throw new E_ACCOUNT_KIT_INVALID_TOKEN()
        return { user: accepted, invitationIds }
      })
    ))
  } catch (error) {
    if (
      error instanceof E_ACCOUNT_KIT_EMAIL_ALREADY_REGISTERED ||
      (await isUserEmailUniqueViolation(error, deps.config, deps.db))
    ) {
      // Recheck after rollback: another acceptance consumes all scopes, while plain signup
      // leaves a still-live invitation and keeps the existing registered-address refusal.
      if (!(await inspectInvitation(deps.db, { token: input.token })))
        throw new E_ACCOUNT_KIT_INVALID_TOKEN()
      throw new E_ACCOUNT_KIT_EMAIL_ALREADY_REGISTERED()
    }
    throw error
  }
  await finishCommitted(fault, 'Invitation committed but follow-ups failed', () =>
    postCommit(
      'Invitation follow-up failed',
      emitInvitationAccepted(deps.config, result.invitationIds, result.user.id, operationId)
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
    .where('expires_at', '>', sqlTimestamp(db, DateTime.utc()))
    .first()
  return row ? { email: row.email, role: row.role } : null
}

/** @throws {AggregateError} If transaction work and cleanup fail before a commit is confirmed. */
export async function sendInvitation(
  deps: ServiceDependencies,
  input: InvitationsSendInput
): Promise<Invitation> {
  if (!isEmailShaped(input.email)) throw new E_ACCOUNT_KIT_INVALID_INPUT('Invalid email')
  if (!isInvitationRole(input.role)) throw new E_ACCOUNT_KIT_INVALID_INPUT('Invalid role')
  const scope = normalizeScope(input.scope)
  const email = normalizeEmail(input.email)
  const actor = await requireUser(deps.config, input.actorId)
  if ((await deps.config.authorize.invite(actor, input.role, { scope })) !== true)
    throw new E_ACCOUNT_KIT_AUTHORIZATION()
  // Spend the actor's budget first: the registered-address answer below must not be free to probe.
  await deps.throttler.consume(
    'invitation:send:actor',
    String(actor.id),
    deps.config.invitationThrottle.sendActor
  )
  if (await deps.config.users.findByEmail(email)) throw new E_ACCOUNT_KIT_EMAIL_ALREADY_REGISTERED()
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
      createLifecycleEffect(deps.config, {
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
 * the actor and operator paths; a pending invitation otherwise surfaces as E_ACCOUNT_KIT_INVITATION_PENDING.
 * `recheckInvite` locks the inviter row and runs `authorize.invite` again with `trx` and the
 * scope. Lock order: inviter, invitation, then whatever the application locks in `invite`.
 *
 * @throws {AggregateError} If transaction work and cleanup fail before a commit is confirmed.
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
): Promise<{ invitation: Invitation; fault?: InstanceType<typeof E_ACCOUNT_KIT_POST_COMMIT> }> {
  try {
    return await settleCommitted(
      transaction(deps.db, async (trx) => {
        let inviter: AccountUser | null | undefined
        if (input.recheckInvite && input.inviterId !== null) {
          await lockUser(trx, deps.config, input.inviterId)
          inviter = await deps.config.users.findById(input.inviterId, trx)
          if (!inviter) throw new E_ACCOUNT_KIT_AUTHORIZATION()
        }
        const now = DateTime.utc()
        const scope = encodeScopeColumn(input.scope)
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
          throw new E_ACCOUNT_KIT_AUTHORIZATION()
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
      throw new E_ACCOUNT_KIT_INVITATION_PENDING()
    throw error
  }
}
