import { sqlTimestamp } from './timestamps.ts'
import { randomUUID } from 'node:crypto'
import { DateTime } from 'luxon'
import { invalidateChangedCredentials } from './credential_revision.ts'
import { isActiveAccount } from './account_projection.ts'
import { clearPendingSocialIdentities, clearRecoveryTokens } from './credential_cleanup.ts'
import { consumeUserToken, transaction } from './db.ts'
import { finishCommitted, createLifecycleEffect, postCommit, settleCommitted } from './effects.ts'
import { E_ACCOUNT_KIT_INVALID_INPUT, E_ACCOUNT_KIT_INVALID_TOKEN } from './errors.ts'
import { emitInvitationAccepted, matchInvitation } from './invitation_match.ts'
import { isPasswordAllowed } from './password.ts'
import { preparePassword, storePassword } from './password_hashing.ts'
import { hashToken, isTokenShaped } from './tokens.ts'
import type {
  AccountUser,
  PasswordResetInspectInput,
  PasswordResetCompleteInput,
  UserId,
} from './types.ts'
import type { ServiceDependencies } from './service_dependencies.ts'

export { requestPasswordReset, issueResetToken } from './password_reset_request.ts'

export async function inspectPasswordReset(
  deps: Pick<ServiceDependencies, 'config' | 'db'>,
  input: PasswordResetInspectInput
): Promise<boolean> {
  if (!isTokenShaped(input.token)) return false
  const row = await deps.db
    .from('password_reset_tokens')
    .select('tokenable_id', 'email')
    .where('hash', hashToken(input.token))
    .where('expires_at', '>', sqlTimestamp(deps.db, DateTime.utc()))
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
    throw new E_ACCOUNT_KIT_INVALID_INPUT('Invalid password')
  if (!isTokenShaped(input.token)) throw new E_ACCOUNT_KIT_INVALID_TOKEN()
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
      let invitationIds: number[] = []
      if (!isActiveAccount(current)) {
        const now = DateTime.utc()
        await deps.config.users.markEmailVerified(row.tokenable_id, now, trx)
        invitationIds = await matchInvitation(deps.config, trx, current, now)
      }
      await clearRecoveryTokens(trx, row.tokenable_id, ['email_verification_tokens'])
      const reloaded = await deps.config.users.findById(row.tokenable_id, trx)
      if (!reloaded) throw new E_ACCOUNT_KIT_INVALID_TOKEN()
      await invalidateChangedCredentials(trx, deps.config, reloaded, {
        operation: 'password_reset',
        operationId,
        userId: reloaded.id,
      })
      return { user: reloaded, invitationIds }
    })
  )
  const user = reset.user

  const context = { operation: 'password_reset' as const, operationId, userId: user.id }
  await finishCommitted(fault, 'Credentials changed but follow-ups failed', () =>
    postCommit('Credentials changed but a follow-up failed', [
      { kind: 'observer', run: () => deps.config.onCredentialsChanged?.(user, context) },
      { kind: 'delivery', run: () => deps.config.notify.passwordResetCompleted(user, context) },
      createLifecycleEffect(deps.config, { type: 'password.reset', userId: user.id, operationId }),
      ...emitInvitationAccepted(deps.config, reset.invitationIds, user.id, operationId),
    ])
  )
  return user
}
