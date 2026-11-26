import { RuntimeException } from '@adonisjs/core/exceptions'
// Profile update: registration fields, and the address change that issues the `email_change` proof.
import { randomUUID } from 'node:crypto'
import { sqlTimestamp } from './timestamps.ts'
import { DateTime } from 'luxon'
import { isActiveAccount } from './account_projection.ts'
import { isUserEmailUniqueViolation, transaction } from './db.ts'
import { finishCommitted, createLifecycleEffect, postCommit, settleCommitted } from './effects.ts'
import { isEmailShaped, normalizeEmail } from './email.ts'
import {
  E_ACCOUNT_KIT_EMAIL_ALREADY_REGISTERED,
  E_ACCOUNT_KIT_INVALID_INPUT,
  type E_ACCOUNT_KIT_POST_COMMIT,
} from './errors.ts'
import { mapRegistrationFields } from './registration_fields.ts'
import { clearRecoveryTokens } from './credential_cleanup.ts'
import { confirmActor, requireUser } from './actor_confirmation.ts'
import { generateToken, hashToken } from './tokens.ts'
import { isRecentIssue, reopenResendOnFailure } from './token_reuse.ts'
import { expiresAt } from './ttl.ts'
import { invalidateChangedCredentials, revision } from './credential_revision.ts'
import { rememberCorrectionRevision } from './profile_correction_revision.ts'
import type { AccountUser, RequestEmailChangeInput, UpdateProfileInput } from './types.ts'
import type { ServiceDependencies } from './service_dependencies.ts'

/** @throws {AggregateError} If transaction work and cleanup fail before a commit is confirmed. */
export async function requestEmailChange(
  deps: ServiceDependencies,
  input: RequestEmailChangeInput
): Promise<void> {
  await updateProfile(deps, {
    actorId: input.actorId,
    currentPassword: input.currentPassword,
    recentProof: input.recentProof,
    email: input.newEmail,
  })
}

/** @throws {AggregateError} If transaction work and cleanup fail before a commit is confirmed. */
export async function updateProfile(
  deps: ServiceDependencies,
  input: UpdateProfileInput
): Promise<AccountUser> {
  const hasRegistrationData = Object.hasOwn(input, 'registrationData')
  if (input.email === undefined && !hasRegistrationData)
    throw new E_ACCOUNT_KIT_INVALID_INPUT('Profile update is empty')
  if (input.email !== undefined && !isEmailShaped(input.email))
    throw new E_ACCOUNT_KIT_INVALID_INPUT('Invalid email')
  const newEmail = input.email === undefined ? undefined : normalizeEmail(input.email)
  const registrationData = hasRegistrationData
    ? await mapRegistrationFields(deps.config, input.registrationData)
    : undefined
  await deps.throttler.consume('identity:user', String(input.actorId), deps.config.throttle)

  const token = generateToken(deps.config.tokenSecretLength)
  const operationId = randomUUID()
  let issued: {
    user: AccountUser
    changedConfirmedEmail: boolean
    send: boolean
    revision?: string | null
  }
  let fault: InstanceType<typeof E_ACCOUNT_KIT_POST_COMMIT> | undefined
  try {
    ;({ value: issued, fault } = await settleCommitted(
      transaction(deps.db, async (trx) => {
        const current = await confirmActor(deps.config, trx, {
          actorId: input.actorId,
          currentPassword: input.currentPassword,
          recentProof: input.recentProof,
          purpose: 'email_change',
        })
        if (registrationData !== undefined) {
          if (!deps.config.users.updateRegistrationData)
            throw new E_ACCOUNT_KIT_INVALID_INPUT(
              'Profile fields are not supported by the user adapter'
            )
          await deps.config.users.updateRegistrationData(current.id, registrationData, trx)
        }
        if (newEmail === undefined || newEmail === current.email) {
          if (
            newEmail !== undefined &&
            current.unverifiedEmail !== null &&
            current.unverifiedEmail !== current.email
          ) {
            await deps.config.users.setUnverifiedEmail(current.id, null, trx)
            await clearRecoveryTokens(trx, current.id, ['email_verification_tokens'])
          }
          const reloaded = await requireUser(deps.config, current.id, trx)
          return { user: reloaded, changedConfirmedEmail: false, send: false }
        }
        if (await deps.config.users.findByEmail(newEmail, trx))
          throw new E_ACCOUNT_KIT_EMAIL_ALREADY_REGISTERED()

        const now = DateTime.utc()
        const inactive = !isActiveAccount(current)
        if (current.unverifiedEmail === newEmail) {
          const previous = await trx
            .from('email_verification_tokens')
            .select('created_at', 'expires_at', 'email', 'current_email', 'purpose')
            .where('tokenable_id', current.id)
            .first()
          if (
            isRecentIssue(
              previous,
              { purpose: 'email_change', email: newEmail, currentEmail: current.email },
              now
            )
          ) {
            const reloaded = await requireUser(deps.config, current.id, trx)
            return { user: reloaded, changedConfirmedEmail: false, send: false }
          }
        }
        if (inactive) {
          await deps.config.users.setEmail(current.id, newEmail, trx)
          await clearRecoveryTokens(trx, current.id, ['password_reset_tokens'])
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
            expires_at: sqlTimestamp(trx, expiresAt(now, deps.config.expiresIn.emailChange)),
            created_at: sqlTimestamp(trx, now),
          })
          .onConflict('tokenable_id')
          .merge(['email', 'current_email', 'purpose', 'hash', 'expires_at', 'created_at'])
        if (inactive) {
          const reloaded = await requireUser(deps.config, current.id, trx)
          await invalidateChangedCredentials(
            trx,
            deps.config,
            reloaded,
            { operation: 'email_change', operationId, userId: current.id },
            input.keepCurrent
          )
        }
        const issuedUser = await requireUser(deps.config, current.id, trx)
        return {
          user: issuedUser,
          changedConfirmedEmail: inactive,
          send: true,
          ...(inactive && deps.config.authentication
            ? { revision: await revision(trx, deps.config, current.id) }
            : {}),
        }
      })
    ))
  } catch (error) {
    if (await isUserEmailUniqueViolation(error, deps.config, deps.db))
      throw new E_ACCOUNT_KIT_EMAIL_ALREADY_REGISTERED()
    throw error
  }
  if (!issued.send) {
    if (fault) throw fault
    return issued.user
  }

  const { user: actor, changedConfirmedEmail } = issued
  if (newEmail === undefined) throw new RuntimeException('Missing email for issued profile proof')
  const context = { operation: 'email_change' as const, operationId, userId: actor.id }
  const committed = issued.revision
  if (committed !== undefined) rememberCorrectionRevision(actor, committed)
  try {
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
            reopenResendOnFailure(deps.db, token, () =>
              changedConfirmedEmail
                ? deps.config.notify.accountActivationProvision(
                    actor,
                    deps.config.urls.emailVerification(token)
                  )
                : deps.config.notify.emailChangeProvision(
                    actor,
                    newEmail,
                    deps.config.urls.emailChange(token)
                  )
            ),
        },
        createLifecycleEffect(deps.config, {
          type: 'email_change.requested',
          userId: actor.id,
          operationId,
        }),
      ])
    )
  } catch (error) {
    // The correction committed: the caller still needs the revision to keep its own session.
    if (committed !== undefined && error !== null && typeof error === 'object')
      rememberCorrectionRevision(error, committed)
    throw error
  }
  return actor
}
