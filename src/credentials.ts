import type { Database } from '@adonisjs/lucid/database'
import type { LimiterService } from '@adonisjs/limiter/types'
import { DateTime } from 'luxon'
import { consumeUserToken, isUniqueViolation, lockRow, transaction } from './db.js'
import { afterCommit, deliver } from './effects.js'
import { isEmailShaped, normaliseEmail } from './email.js'
import {
  EmailAlreadyRegisteredError,
  IdentityNotConfirmedError,
  InvalidInputError,
  InvalidTokenError,
  NoPasswordError,
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
  await lockRow(trx, config.usersTable, actorId)
  const actor = await config.users.findById(actorId, trx, { forUpdate: true })
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

  await consume(deps.limiter, 'identity:user', String(input.actorId), deps.config.throttle)
  const user = await transaction(deps.db, async (trx) => {
    const actor = await confirmActor(deps.config, trx, input.actorId, input.currentPassword)
    await deps.config.users.setPassword(actor.id, input.newPassword, trx)
    await trx.from('account_recovery_tokens').where('user_id', actor.id).delete()
    await trx.from('account_email_changes').where('user_id', actor.id).delete()
    const reloaded = await deps.config.users.findById(actor.id, trx)
    if (!reloaded) throw new InvalidInputError('Unknown actor')
    return reloaded
  })

  await afterCommit('Credentials changed but the callback failed', () =>
    deps.config.onCredentialsChanged?.(user)
  )
}

export async function requestEmailChange(
  deps: { config: ResolvedConfig; db: Database; limiter: LimiterService },
  input: CredentialsRequestEmailChangeInput
): Promise<void> {
  if (!isEmailShaped(input.newEmail)) throw new InvalidInputError('Invalid email')
  const newEmail = normaliseEmail(input.newEmail)
  await consume(deps.limiter, 'identity:user', String(input.actorId), deps.config.throttle)

  const token = generateToken()
  const actor = await transaction(deps.db, async (trx) => {
    const current = await confirmActor(deps.config, trx, input.actorId, input.currentPassword)
    if (newEmail === current.email) return null
    if (await deps.config.users.findByEmail(newEmail, trx)) throw new EmailAlreadyRegisteredError()

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
  if (!actor) return

  await deliver('Email change notification failed', () =>
    deps.config.notify.emailChangeConfirm(actor, newEmail, deps.config.urls.emailChange(token))
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

  let changed: { user: AccountUser; previousEmail: string }
  try {
    changed = await transaction(deps.db, async (trx) => {
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
      return { user: reloaded, previousEmail: row.current_email }
    })
  } catch (error) {
    if (isUniqueViolation(error, deps.config.usersTable, 'email'))
      throw new EmailAlreadyRegisteredError()
    throw error
  }

  // The previous address learns about the change whether or not the callback succeeds.
  await afterCommit(
    'Email changed but the callback failed',
    () => deps.config.onCredentialsChanged?.(changed.user),
    () => deps.config.notify.emailChanged(changed.previousEmail, changed.user)
  )
  return changed.user
}
