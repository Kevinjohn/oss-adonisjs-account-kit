// Email change: inspecting and completing the `email_change` proof.
import { randomUUID } from 'node:crypto'
import { sqlTimestamp } from './timestamps.js'
import { DateTime } from 'luxon'
import { credentialsChanged } from './credential_revision.js'
import { consumeUserToken, isUserEmailUniqueViolation, transaction } from './db.js'
import { finishCommitted, lifecycle, postCommit, settleCommitted } from './effects.js'
import { EmailAlreadyRegisteredError, InvalidTokenError, type PostCommitError } from './errors.js'
import { clearRecoveryTokens } from './credential_cleanup.js'
import { hashToken, isTokenShaped } from './tokens.js'
import type {
  AccountUser,
  CompleteEmailChangeInput,
  InspectEmailChangeInput,
  UserId,
} from './types.js'
import type { ServiceDependencies } from './service_dependencies.js'

export async function inspectEmailChange(
  deps: Pick<ServiceDependencies, 'config' | 'db'>,
  input: InspectEmailChangeInput
): Promise<boolean> {
  if (!isTokenShaped(input.token)) return false
  const proof = await deps.db
    .from('email_verification_tokens')
    .select('tokenable_id', 'email', 'current_email', 'purpose')
    .where('hash', hashToken(input.token))
    .where('expires_at', '>', sqlTimestamp(deps.db))
    .first()
  if (!proof || proof.purpose !== 'email_change') return false
  const user = await deps.config.users.findById(proof.tokenable_id)
  return user !== null && user.email === proof.current_email && user.unverifiedEmail === proof.email
}

interface EmailChangeRow {
  tokenable_id: UserId
  email: string
  current_email: string
  purpose: string
}

export async function completeEmailChange(
  deps: Pick<ServiceDependencies, 'config' | 'db'>,
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
        await clearRecoveryTokens(trx, user.id, ['password_reset_tokens'])
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
    postCommit('Email changed but a follow-up failed', [
      { kind: 'observer', run: () => deps.config.onCredentialsChanged?.(changed.user, context) },
      {
        kind: 'delivery',
        run: () => deps.config.notify.emailChanged(changed.previousEmail, changed.user),
      },
      lifecycle(deps.config, {
        type: 'email_change.completed',
        userId: changed.user.id,
        operationId,
      }),
    ])
  )
  return changed.user
}
