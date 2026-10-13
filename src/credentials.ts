import type { Database } from '@adonisjs/lucid/database'
import type { LimiterService } from '@adonisjs/limiter/types'
import { DateTime } from 'luxon'
import { consumeEmailChangeToken, isUniqueViolation, lockUser, transaction } from './db.js'
import { isEmailShaped, normaliseEmail } from './email.js'
import {
  DeliveryError,
  EmailAlreadyRegisteredError,
  IdentityNotConfirmedError,
  InvalidInputError,
  InvalidTokenError,
  NoPasswordError,
  PostCommitError,
} from './errors.js'
import { consume } from './throttle.js'
import { generateToken, hashToken, isTokenShaped } from './tokens.js'
import { expiresAt } from './ttl.js'
import type {
  AccountUser,
  CredentialsChangePasswordInput,
  CredentialsCompleteEmailChangeInput,
  CredentialsRequestEmailChangeInput,
  ResolvedConfig,
} from './types.js'

export async function changePassword(
  deps: { config: ResolvedConfig; db: Database; limiter: LimiterService },
  input: CredentialsChangePasswordInput
): Promise<void> {
  if (
    typeof input.newPassword !== 'string' ||
    input.newPassword.length < 8 ||
    input.newPassword.length > 255
  )
    throw new InvalidInputError('Invalid new password')

  await consume(deps.limiter, 'identity:user', String(input.actorId), deps.config.throttle)
  const user = await transaction(deps.db, async (trx) => {
    await lockUser(trx, input.actorId)
    const actor = await deps.config.users.findById(input.actorId, trx, { forUpdate: true })
    if (!actor) throw new InvalidInputError('Unknown actor')
    if (!actor.hasPassword) throw new NoPasswordError()
    if (
      typeof input.currentPassword !== 'string' ||
      input.currentPassword.length === 0 ||
      !(await deps.config.users.verifyPassword(actor.id, input.currentPassword, trx))
    )
      throw new IdentityNotConfirmedError()

    await deps.config.users.setPassword(actor.id, input.newPassword, trx)
    await trx.from('account_recovery_tokens').where('user_id', actor.id).delete()
    await trx.from('account_email_changes').where('user_id', actor.id).delete()
    const reloaded = await deps.config.users.findById(actor.id, trx)
    if (!reloaded) throw new InvalidInputError('Unknown actor')
    return reloaded
  })

  try {
    await deps.config.onCredentialsChanged?.(user)
  } catch (cause) {
    throw new PostCommitError('Credentials changed but the callback failed', { cause })
  }
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
    await lockUser(trx, input.actorId)
    const current = await deps.config.users.findById(input.actorId, trx, { forUpdate: true })
    if (!current) throw new InvalidInputError('Unknown actor')
    if (!current.hasPassword) throw new NoPasswordError()
    if (
      typeof input.currentPassword !== 'string' ||
      input.currentPassword.length === 0 ||
      !(await deps.config.users.verifyPassword(current.id, input.currentPassword, trx))
    )
      throw new IdentityNotConfirmedError()
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

  try {
    await deps.config.notify.emailChangeConfirm(
      actor,
      newEmail,
      deps.config.urls.emailChange(token)
    )
  } catch (cause) {
    throw new DeliveryError('Email change notification failed', { cause })
  }
}

export async function completeEmailChange(
  deps: { config: ResolvedConfig; db: Database },
  input: CredentialsCompleteEmailChangeInput
): Promise<AccountUser> {
  if (!isTokenShaped(input.token)) throw new InvalidTokenError()

  let changed: { user: AccountUser; previousEmail: string }
  try {
    changed = await transaction(deps.db, async (trx) => {
      const tokenHash = hashToken(input.token)
      const candidate = await trx
        .from('account_email_changes')
        .select('user_id')
        .where('token_hash', tokenHash)
        .first()
      if (!candidate) throw new InvalidTokenError()
      await lockUser(trx, candidate.user_id)
      const current = await deps.config.users.findById(candidate.user_id, trx, { forUpdate: true })
      const row = await consumeEmailChangeToken(trx, tokenHash, DateTime.utc().toISO())
      if (
        !row ||
        row.user_id !== candidate.user_id ||
        !current ||
        current.email !== row.current_email
      )
        throw new InvalidTokenError()
      if (await deps.config.users.findByEmail(row.new_email, trx))
        throw new EmailAlreadyRegisteredError()

      await deps.config.users.setEmail(current.id, row.new_email, trx)
      await deps.config.users.markEmailVerified(current.id, DateTime.utc(), trx)
      await trx.from('account_recovery_tokens').where('user_id', current.id).delete()
      const reloaded = await deps.config.users.findById(current.id, trx)
      if (!reloaded) throw new InvalidTokenError()
      return { user: reloaded, previousEmail: row.current_email }
    })
  } catch (error) {
    if (isUniqueViolation(error, 'users', 'email')) throw new EmailAlreadyRegisteredError()
    throw error
  }

  try {
    await deps.config.onCredentialsChanged?.(changed.user)
    await deps.config.notify.emailChanged(changed.previousEmail, changed.user)
  } catch (cause) {
    throw new PostCommitError('Email changed but the callback failed', { cause })
  }
  return changed.user
}
