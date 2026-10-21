import { sqlTimestamp } from './timestamps.js'
import { randomUUID } from 'node:crypto'
import { DateTime } from 'luxon'
import { credentialsChanged } from './authentication.js'
import { clearPendingSocialIdentities, clearRecoveryTokens } from './credential_cleanup.js'
import { consumeUserToken, transaction } from './db.js'
import { afterCommit, finishCommitted, settleCommitted } from './effects.js'
import { InvalidInputError, InvalidTokenError } from './errors.js'
import { invitationAccepted, matchInvitation } from './invitation_match.js'
import { isPasswordAllowed } from './password.js'
import { preparePassword, storePassword } from './password_hashing.js'
import { hashToken, isTokenShaped } from './tokens.js'
import type {
  AccountUser,
  PasswordResetInspectInput,
  PasswordResetCompleteInput,
  UserId,
} from './types.js'
import type { ServiceDependencies } from './service_dependencies.js'

export { requestPasswordReset, issueResetToken } from './password_reset_request.js'

export async function inspectPasswordReset(
  deps: Pick<ServiceDependencies, 'config' | 'db'>,
  input: PasswordResetInspectInput
): Promise<boolean> {
  if (!isTokenShaped(input.token)) return false
  const row = await deps.db
    .from('password_reset_tokens')
    .select('tokenable_id', 'email')
    .where('hash', hashToken(input.token))
    .where('expires_at', '>', sqlTimestamp(deps.db))
    .first()
  if (!row) return false
  const user = await deps.config.users.findById(row.tokenable_id)
  return user !== null && user.email === row.email
}

export async function completePasswordReset(
  deps: Pick<ServiceDependencies, 'config' | 'db'>,
  input: PasswordResetCompleteInput
): Promise<AccountUser> {
  if (!isPasswordAllowed(input.password, deps.config.passwordPolicy))
    throw new InvalidInputError('Invalid password')
  if (!isTokenShaped(input.token)) throw new InvalidTokenError()
  const operationId = randomUUID()
  const password = await preparePassword(deps.config.users, input.password)

  const { value: reset, fault } = await settleCommitted(
    transaction(deps.db, async (trx) => {
      const { row, user: current } = await consumeUserToken<{
        tokenable_id: UserId
        email: string
      }>(
        trx,
        deps.config,
        'password_reset_tokens',
        input.token,
        (candidate, account) => candidate.email === account.email
      )

      await storePassword(deps.config.users, row.tokenable_id, password, trx)
      if (deps.config.enabled.includes('socialAuthentication'))
        await clearPendingSocialIdentities(trx, row.tokenable_id)
      if (current.unverifiedEmail !== null && current.unverifiedEmail !== current.email)
        await deps.config.users.setUnverifiedEmail(row.tokenable_id, null, trx)
      // A reset proves control of the address, so it confirms a never-confirmed account and
      // consumes an invitation waiting for it, like activation.
      let invitationId: number | null = null
      if (current.unverifiedEmail === current.email) {
        const now = DateTime.utc()
        await deps.config.users.markEmailVerified(row.tokenable_id, now, trx)
        invitationId = await matchInvitation(deps.config, trx, current, now)
      }
      await clearRecoveryTokens(trx, row.tokenable_id, ['email_verification_tokens'])
      const reloaded = await deps.config.users.findById(row.tokenable_id, trx)
      if (!reloaded) throw new InvalidTokenError()
      await credentialsChanged(trx, deps.config, reloaded, {
        operation: 'password_reset',
        operationId,
        userId: reloaded.id,
      })
      return { user: reloaded, invitationId }
    })
  )
  const user = reset.user

  const context = { operation: 'password_reset' as const, operationId, userId: user.id }
  await finishCommitted(fault, 'Credentials changed but follow-ups failed', () =>
    afterCommit(
      'Credentials changed but a follow-up failed',
      () => deps.config.onCredentialsChanged?.(user, context),
      () => deps.config.notify.passwordResetCompleted(user, context),
      () =>
        deps.config.onLifecycleEvent?.({ type: 'password.reset', userId: user.id, operationId }),
      ...invitationAccepted(deps.config, reset.invitationId, user.id, operationId).map(
        (effect) => effect.run
      )
    )
  )
  return user
}
