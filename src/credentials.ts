import { randomUUID } from 'node:crypto'
import type { Database } from '@adonisjs/lucid/database'
import type { LimiterService } from '@adonisjs/limiter/types'
import { DateTime } from 'luxon'
import { consumeUserToken, isUserEmailUniqueViolation, lockUser, transaction } from './db.js'
import { afterCommit, finishCommitted, postCommit, settleCommitted } from './effects.js'
import { isEmailShaped, normaliseEmail } from './email.js'
import {
  EmailAlreadyRegisteredError,
  IdentityNotConfirmedError,
  InvalidInputError,
  InvalidTokenError,
  NoPasswordError,
  type PostCommitError,
} from './errors.js'
import { isPasswordShaped } from './password.js'
import { consume } from './throttle.js'
import { generateToken, hashToken, isTokenShaped } from './tokens.js'
import { expiresAt } from './ttl.js'
import type {
  AccountUser,
  CredentialsChangePasswordInput,
  CredentialsCompleteEmailChangeInput,
  CredentialsRequestEmailChangeInput,
  ResolvedConfig,
  Trx,
  UserId,
} from './types.js'

/** Lock the actor and prove the current password before any credential write. */
async function confirmActor(
  config: ResolvedConfig,
  trx: Trx,
  actorId: UserId,
  currentPassword: unknown
): Promise<AccountUser> {
  await lockUser(trx, config, actorId)
  const actor = await config.users.findById(actorId, trx)
  if (!actor) throw new InvalidInputError('Unknown actor')
  if (!actor.hasPassword) throw new NoPasswordError()
  if (
    typeof currentPassword !== 'string' ||
    currentPassword.length === 0 ||
    !(await config.users.verifyPassword(actor.id, currentPassword, trx))
  )
    throw new IdentityNotConfirmedError()
  return actor
}

export async function changePassword(
  deps: { config: ResolvedConfig; db: Database; limiter: LimiterService },
  input: CredentialsChangePasswordInput
): Promise<void> {
  if (!isPasswordShaped(input.newPassword)) throw new InvalidInputError('Invalid new password')

  await consume(
    deps.limiter,
    'identity:user',
    String(input.actorId),
    deps.config.throttle,
    deps.config.limiterSecret,
    deps.config.limiterNamespace
  )
  const operationId = randomUUID()
  const { value: user, fault } = await settleCommitted(
    transaction(deps.db, async (trx) => {
      const actor = await confirmActor(deps.config, trx, input.actorId, input.currentPassword)
      await deps.config.users.setPassword(actor.id, input.newPassword, trx)
      await trx.from('account_recovery_tokens').where('user_id', actor.id).delete()
      await trx.from('account_email_changes').where('user_id', actor.id).delete()
      const reloaded = await deps.config.users.findById(actor.id, trx)
      if (!reloaded) throw new InvalidInputError('Unknown actor')
      await deps.config.onCredentialsChangedTransaction?.(
        reloaded,
        { operation: 'password_change', operationId, userId: reloaded.id },
        trx
      )
      return reloaded
    })
  )

  const context = { operation: 'password_change' as const, operationId, userId: user.id }
  await finishCommitted(fault, 'Credentials changed but follow-ups failed', () =>
    afterCommit(
      'Credentials changed but a follow-up failed',
      () => deps.config.onCredentialsChanged?.(user, context),
      () => deps.config.notify.passwordChanged(user, context),
      () =>
        deps.config.onLifecycleEvent?.({ type: 'password.changed', userId: user.id, operationId })
    )
  )
}

export async function requestEmailChange(
  deps: { config: ResolvedConfig; db: Database; limiter: LimiterService },
  input: CredentialsRequestEmailChangeInput
): Promise<void> {
  if (!isEmailShaped(input.newEmail)) throw new InvalidInputError('Invalid email')
  const newEmail = normaliseEmail(input.newEmail)
  await consume(
    deps.limiter,
    'identity:user',
    String(input.actorId),
    deps.config.throttle,
    deps.config.limiterSecret,
    deps.config.limiterNamespace
  )

  const token = generateToken()
  const operationId = randomUUID()
  const { value: actor, fault } = await settleCommitted(
    transaction(deps.db, async (trx) => {
      const current = await confirmActor(deps.config, trx, input.actorId, input.currentPassword)
      if (newEmail === current.email) return null
      if (await deps.config.users.findByEmail(newEmail, trx))
        throw new EmailAlreadyRegisteredError()

      const now = DateTime.utc()
      await trx
        .table('account_email_changes')
        .insert({
          user_id: current.id,
          current_email: current.email,
          new_email: newEmail,
          token_hash: hashToken(token),
          expires_at: expiresAt(now, deps.config.ttl.emailChange).toISO(),
          created_at: now.toISO(),
        })
        .onConflict('user_id')
        .merge(['current_email', 'new_email', 'token_hash', 'expires_at', 'created_at'])
      return current
    })
  )
  if (!actor) {
    if (fault) throw fault
    return
  }

  await finishCommitted(fault, 'Email change committed but follow-ups failed', () =>
    postCommit('Email change follow-up failed', [
      {
        kind: 'delivery',
        run: () =>
          deps.config.notify.emailChangeConfirm(
            actor,
            newEmail,
            deps.config.urls.emailChange(token)
          ),
      },
      {
        kind: 'observer',
        run: () =>
          deps.config.onLifecycleEvent?.({
            type: 'email_change.requested',
            userId: actor.id,
            operationId,
          }),
      },
    ])
  )
}

interface EmailChangeRow {
  user_id: UserId
  current_email: string
  new_email: string
}

export async function completeEmailChange(
  deps: { config: ResolvedConfig; db: Database },
  input: CredentialsCompleteEmailChangeInput
): Promise<AccountUser> {
  if (!isTokenShaped(input.token)) throw new InvalidTokenError()
  const operationId = randomUUID()

  let changed: { user: AccountUser; previousEmail: string }
  let fault: PostCommitError | undefined
  try {
    ;({ value: changed, fault } = await settleCommitted(
      transaction(deps.db, async (trx) => {
        const { row, user } = await consumeUserToken<EmailChangeRow>(
          trx,
          deps.config,
          'account_email_changes',
          input.token,
          (candidate) => candidate.current_email
        )
        if (await deps.config.users.findByEmail(row.new_email, trx))
          throw new EmailAlreadyRegisteredError()

        await deps.config.users.setEmail(user.id, row.new_email, trx)
        await deps.config.users.markEmailVerified(user.id, DateTime.utc(), trx)
        await trx.from('account_recovery_tokens').where('user_id', user.id).delete()
        const reloaded = await deps.config.users.findById(user.id, trx)
        if (!reloaded) throw new InvalidTokenError()
        await deps.config.onCredentialsChangedTransaction?.(
          reloaded,
          { operation: 'email_change', operationId, userId: reloaded.id },
          trx
        )
        return { user: reloaded, previousEmail: row.current_email }
      })
    ))
  } catch (error) {
    if (await isUserEmailUniqueViolation(error, deps.config, deps.db))
      throw new EmailAlreadyRegisteredError()
    throw error
  }

  // The previous address learns about the change whether or not the callback succeeds.
  const context = { operation: 'email_change' as const, operationId, userId: changed.user.id }
  await finishCommitted(fault, 'Email changed but follow-ups failed', () =>
    afterCommit(
      'Email changed but a follow-up failed',
      () => deps.config.onCredentialsChanged?.(changed.user, context),
      () => deps.config.notify.emailChanged(changed.previousEmail, changed.user),
      () =>
        deps.config.onLifecycleEvent?.({
          type: 'email_change.completed',
          userId: changed.user.id,
          operationId,
        })
    )
  )
  return changed.user
}
