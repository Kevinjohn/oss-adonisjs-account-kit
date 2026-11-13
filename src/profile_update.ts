// Profile update: registration fields, and the address change that issues the `email_change` proof.
import { randomUUID } from 'node:crypto'
import { sqlTimestamp } from './timestamps.js'
import { DateTime } from 'luxon'
import { credentialsChanged } from './authentication.js'
import { isActiveAccount } from './account_projection.js'
import { isUserEmailUniqueViolation, transaction } from './db.js'
import { finishCommitted, lifecycle, postCommit, settleCommitted } from './effects.js'
import { isEmailShaped, normalizeEmail } from './email.js'
import { EmailAlreadyRegisteredError, InvalidInputError, type PostCommitError } from './errors.js'
import { mapRegistrationFields } from './registration_fields.js'
import { throttlerOf } from './throttle.js'
import { clearRecoveryTokens } from './credential_cleanup.js'
import { confirmActor, requireUser } from './actor_confirmation.js'
import { generateToken, hashToken } from './tokens.js'
import { isRecentIssue, reopenResendOnFailure } from './token_reuse.js'
import { expiresAt } from './ttl.js'
import { revision } from './credential_revision.js'
import { rememberCorrectionRevision } from './profile_correction_revision.js'
import type { AccountUser, RequestEmailChangeInput, UpdateProfileInput } from './types.js'
import type { ServiceDependencies } from './service_dependencies.js'

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

export async function updateProfile(
  deps: ServiceDependencies,
  input: UpdateProfileInput
): Promise<AccountUser> {
  const hasRegistrationData = Object.hasOwn(input, 'registrationData')
  if (input.email === undefined && !hasRegistrationData)
    throw new InvalidInputError('Profile update is empty')
  if (input.email !== undefined && !isEmailShaped(input.email))
    throw new InvalidInputError('Invalid email')
  const newEmail = input.email === undefined ? undefined : normalizeEmail(input.email)
  const registrationData = hasRegistrationData
    ? await mapRegistrationFields(deps.config, input.registrationData)
    : undefined
  await throttlerOf(deps).consume('identity:user', String(input.actorId), deps.config.throttle)

  const token = generateToken(deps.config.tokenSecretLength)
  const operationId = randomUUID()
  let issued: {
    user: AccountUser
    changedConfirmedEmail: boolean
    send: boolean
    revision?: string | null
  }
  let fault: PostCommitError | undefined
  try {
    ;({ value: issued, fault } = await settleCommitted(
      transaction(deps.db, async (trx) => {
        const current = await confirmActor(
          deps.config,
          trx,
          input.actorId,
          input.currentPassword,
          input.recentProof,
          'email_change'
        )
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
            await clearRecoveryTokens(trx, current.id, ['email_verification_tokens'])
          }
          const reloaded = await requireUser(deps.config, current.id, trx)
          return { user: reloaded, changedConfirmedEmail: false, send: false }
        }
        if (await deps.config.users.findByEmail(newEmail, trx))
          throw new EmailAlreadyRegisteredError()

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
          await credentialsChanged(
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
          ...(inactive ? { revision: await revision(trx, deps.config, current.id) } : {}),
        }
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
        lifecycle(deps.config, {
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
