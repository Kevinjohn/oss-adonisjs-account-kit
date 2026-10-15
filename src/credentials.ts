import { randomUUID } from 'node:crypto'
import type { Database } from '@adonisjs/lucid/database'
import type { LimiterService } from '@adonisjs/limiter/types'
import { DateTime } from 'luxon'
import { credentialsChanged } from './authentication.js'
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
import { isPasswordAllowed } from './password.js'
import { mapRegistrationFields } from './registration_fields.js'
import { consume } from './throttle.js'
import { generateToken, hashToken, isTokenShaped } from './tokens.js'
import { expiresAt } from './ttl.js'
import type {
  AccountUser,
  ChangePasswordInput,
  CompleteEmailChangeInput,
  InspectEmailChangeInput,
  RequestEmailChangeInput,
  ResolvedConfig,
  Trx,
  UpdateProfileInput,
  UserId,
} from './types.js'

export async function inspectEmailChange(
  deps: { config: ResolvedConfig; db: Database },
  input: InspectEmailChangeInput
): Promise<boolean> {
  if (!isTokenShaped(input.token)) return false
  const proof = await deps.db
    .from('email_verification_tokens')
    .select('tokenable_id', 'email', 'current_email', 'purpose')
    .where('hash', hashToken(input.token))
    .where('expires_at', '>', DateTime.utc().toISO())
    .first()
  if (!proof || proof.purpose !== 'email_change') return false
  const user = await deps.config.users.findById(proof.tokenable_id)
  return user !== null && user.email === proof.current_email && user.unverifiedEmail === proof.email
}

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
  input: ChangePasswordInput
): Promise<void> {
  if (!isPasswordAllowed(input.newPassword, deps.config.passwordPolicy))
    throw new InvalidInputError('Invalid new password')

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
      if (actor.unverifiedEmail !== null && actor.unverifiedEmail !== actor.email)
        await deps.config.users.setUnverifiedEmail(actor.id, null, trx)
      await trx.from('password_reset_tokens').where('tokenable_id', actor.id).delete()
      await trx.from('email_verification_tokens').where('tokenable_id', actor.id).delete()
      const reloaded = await deps.config.users.findById(actor.id, trx)
      if (!reloaded) throw new InvalidInputError('Unknown actor')
      await credentialsChanged(trx, deps.config, reloaded, {
        operation: 'password_change',
        operationId,
        userId: reloaded.id,
      })
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
  input: RequestEmailChangeInput
): Promise<void> {
  await updateProfile(deps, {
    actorId: input.actorId,
    currentPassword: input.currentPassword,
    email: input.newEmail,
  })
}

export async function updateProfile(
  deps: { config: ResolvedConfig; db: Database; limiter: LimiterService },
  input: UpdateProfileInput
): Promise<AccountUser> {
  if (input.email === undefined && input.registrationData === undefined)
    throw new InvalidInputError('Profile update is empty')
  if (input.email !== undefined && !isEmailShaped(input.email))
    throw new InvalidInputError('Invalid email')
  const newEmail = input.email === undefined ? undefined : normaliseEmail(input.email)
  const registrationData = await mapRegistrationFields(deps.config, input.registrationData)
  await consume(
    deps.limiter,
    'identity:user',
    String(input.actorId),
    deps.config.throttle,
    deps.config.limiterSecret,
    deps.config.limiterNamespace
  )

  const token = generateToken(deps.config.tokenSecretLength)
  const operationId = randomUUID()
  let issued: { user: AccountUser; changedConfirmedEmail: boolean; send: boolean }
  let fault: PostCommitError | undefined
  try {
    ;({ value: issued, fault } = await settleCommitted(
      transaction(deps.db, async (trx) => {
        const current = await confirmActor(deps.config, trx, input.actorId, input.currentPassword)
        if (registrationData !== undefined) {
          if (!deps.config.users.updateRegistrationData)
            throw new InvalidInputError('Profile fields are not supported by the user adapter')
          await deps.config.users.updateRegistrationData(current.id, registrationData, trx)
        }
        if (newEmail === undefined || newEmail === current.email) {
          if (
            newEmail !== undefined &&
            current.unverifiedEmail !== null &&
            current.unverifiedEmail !== current.email
          ) {
            await deps.config.users.setUnverifiedEmail(current.id, null, trx)
            await trx.from('email_verification_tokens').where('tokenable_id', current.id).delete()
          }
          const reloaded = await deps.config.users.findById(current.id, trx)
          if (!reloaded) throw new InvalidInputError('Unknown actor')
          return { user: reloaded, changedConfirmedEmail: false, send: false }
        }
        if (await deps.config.users.findByEmail(newEmail, trx))
          throw new EmailAlreadyRegisteredError()

        const now = DateTime.utc()
        const inactive = current.unverifiedEmail === current.email
        if (current.unverifiedEmail === newEmail) {
          const previous = await trx
            .from('email_verification_tokens')
            .select('created_at', 'email', 'current_email', 'purpose')
            .where('tokenable_id', current.id)
            .first()
          if (
            previous?.purpose === 'email_change' &&
            previous.email === newEmail &&
            previous.current_email === current.email &&
            DateTime.fromJSDate(new Date(previous.created_at)).toMillis() >
              now.minus({ minutes: 1 }).toMillis()
          ) {
            const reloaded = await deps.config.users.findById(current.id, trx)
            if (!reloaded) throw new InvalidInputError('Unknown actor')
            return { user: reloaded, changedConfirmedEmail: false, send: false }
          }
        }
        if (inactive) {
          await deps.config.users.setEmail(current.id, newEmail, trx)
          await trx.from('password_reset_tokens').where('tokenable_id', current.id).delete()
        }
        await deps.config.users.setUnverifiedEmail(current.id, newEmail, trx)
        await trx
          .table('email_verification_tokens')
          .insert({
            tokenable_id: current.id,
            email: newEmail,
            current_email: inactive ? newEmail : current.email,
            purpose: inactive ? 'activation' : 'email_change',
            hash: hashToken(token),
            expires_at: expiresAt(now, deps.config.expiresIn.emailChange).toISO(),
            created_at: now.toISO(),
          })
          .onConflict('tokenable_id')
          .merge(['email', 'current_email', 'purpose', 'hash', 'expires_at', 'created_at'])
        if (inactive) {
          const reloaded = await deps.config.users.findById(current.id, trx)
          if (!reloaded) throw new InvalidInputError('Unknown actor')
          await credentialsChanged(trx, deps.config, reloaded, {
            operation: 'email_change',
            operationId,
            userId: current.id,
          })
        }
        const issuedUser = await deps.config.users.findById(current.id, trx)
        if (!issuedUser) throw new InvalidInputError('Unknown actor')
        return { user: issuedUser, changedConfirmedEmail: inactive, send: true }
      })
    ))
  } catch (error) {
    if (await isUserEmailUniqueViolation(error, deps.config, deps.db))
      throw new EmailAlreadyRegisteredError()
    throw error
  }
  if (!issued.send) {
    if (fault) throw fault
    return issued.user
  }

  const { user: actor, changedConfirmedEmail } = issued
  if (newEmail === undefined) throw new Error('Missing email for issued profile proof')
  const context = { operation: 'email_change' as const, operationId, userId: actor.id }
  await finishCommitted(fault, 'Email change committed but follow-ups failed', () =>
    postCommit('Email change follow-up failed', [
      {
        kind: 'observer',
        run: () =>
          changedConfirmedEmail ? deps.config.onCredentialsChanged?.(actor, context) : undefined,
      },
      {
        kind: 'delivery',
        run: () =>
          changedConfirmedEmail
            ? deps.config.notify.accountActivationProvision(
                actor,
                deps.config.urls.emailVerification(token)
              )
            : deps.config.notify.emailChangeProvision(
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
  return actor
}

interface EmailChangeRow {
  tokenable_id: UserId
  email: string
  current_email: string
  purpose: string
}

export async function completeEmailChange(
  deps: { config: ResolvedConfig; db: Database },
  input: CompleteEmailChangeInput
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
          'email_verification_tokens',
          input.token,
          (candidate, current) =>
            candidate.purpose === 'email_change' &&
            candidate.email === current.unverifiedEmail &&
            candidate.current_email === current.email
        )
        const colliding = await deps.config.users.findByEmail(row.email, trx)
        if (colliding && colliding.id !== user.id) throw new EmailAlreadyRegisteredError()

        await deps.config.users.setEmail(user.id, row.email, trx)
        await deps.config.users.markEmailVerified(user.id, DateTime.utc(), trx)
        await trx.from('password_reset_tokens').where('tokenable_id', user.id).delete()
        const reloaded = await deps.config.users.findById(user.id, trx)
        if (!reloaded) throw new InvalidTokenError()
        await credentialsChanged(trx, deps.config, reloaded, {
          operation: 'email_change',
          operationId,
          userId: reloaded.id,
        })
        return { user: reloaded, previousEmail: user.email }
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
