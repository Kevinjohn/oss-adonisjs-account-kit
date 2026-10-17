import { performance } from 'node:perf_hooks'
import { randomUUID } from 'node:crypto'
import { DateTime } from 'luxon'
import { credentialsChanged } from './authentication.js'
import { clearPendingSocialIdentities, clearRecoveryTokens } from './credential_cleanup.js'
import type { Database } from '@adonisjs/lucid/database'
import type { LimiterService } from '@adonisjs/limiter/types'
import { consumeUserToken, lockUser, transaction } from './db.js'
import { afterCommit, finishCommitted, lifecycle, postCommit, settleCommitted } from './effects.js'
import { normaliseEmail, isEmailShaped } from './email.js'
import { InvalidInputError, InvalidTokenError } from './errors.js'
import { isPasswordAllowed } from './password.js'
import { throttlerOf, type Throttler } from './throttle.js'
import { waitForFloor } from './timing.js'
import { generateToken, hashToken, isTokenShaped } from './tokens.js'
import { expiresAt } from './ttl.js'
import type {
  AccountUser,
  PasswordResetInspectInput,
  PasswordResetRequestInput,
  PasswordResetCompleteInput,
  ResolvedConfig,
  UserId,
} from './types.js'

export async function inspectPasswordReset(
  deps: { config: ResolvedConfig; db: Database },
  input: PasswordResetInspectInput
): Promise<boolean> {
  if (!isTokenShaped(input.token)) return false
  const row = await deps.db
    .from('password_reset_tokens')
    .select('tokenable_id', 'email')
    .where('hash', hashToken(input.token))
    .where('expires_at', '>', DateTime.utc().toISO())
    .first()
  if (!row) return false
  const user = await deps.config.users.findById(row.tokenable_id)
  return user !== null && user.email === row.email
}

export async function completePasswordReset(
  deps: { config: ResolvedConfig; db: Database },
  input: PasswordResetCompleteInput
): Promise<AccountUser> {
  if (!isPasswordAllowed(input.password, deps.config.passwordPolicy))
    throw new InvalidInputError('Invalid password')
  if (!isTokenShaped(input.token)) throw new InvalidTokenError()
  const operationId = randomUUID()

  const { value: user, fault } = await settleCommitted(
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

      await deps.config.users.setPassword(row.tokenable_id, input.password, trx)
      if (deps.config.enabled.includes('socialAuthentication'))
        await clearPendingSocialIdentities(trx, row.tokenable_id)
      if (current.unverifiedEmail !== null && current.unverifiedEmail !== current.email)
        await deps.config.users.setUnverifiedEmail(row.tokenable_id, null, trx)
      if (current.unverifiedEmail === current.email)
        await deps.config.users.markEmailVerified(row.tokenable_id, DateTime.utc(), trx)
      await clearRecoveryTokens(trx, row.tokenable_id, ['email_verification_tokens'])
      const reloaded = await deps.config.users.findById(row.tokenable_id, trx)
      if (!reloaded) throw new InvalidTokenError()
      await credentialsChanged(trx, deps.config, reloaded, {
        operation: 'password_reset',
        operationId,
        userId: reloaded.id,
      })
      return reloaded
    })
  )

  const context = { operation: 'password_reset' as const, operationId, userId: user.id }
  await finishCommitted(fault, 'Credentials changed but follow-ups failed', () =>
    afterCommit(
      'Credentials changed but a follow-up failed',
      () => deps.config.onCredentialsChanged?.(user, context),
      () => deps.config.notify.passwordResetCompleted(user, context),
      () => deps.config.onLifecycleEvent?.({ type: 'password.reset', userId: user.id, operationId })
    )
  )
  return user
}

export async function requestPasswordReset(
  deps: { config: ResolvedConfig; db: Database; limiter: LimiterService; throttler?: Throttler },
  input: PasswordResetRequestInput
): Promise<void> {
  const started = performance.now()
  try {
    if (!isEmailShaped(input.email)) throw new InvalidInputError('Invalid email')
    if (typeof input.clientKey !== 'string' || input.clientKey.trim() === '')
      throw new InvalidInputError('Invalid client key')
    const email = normaliseEmail(input.email)

    await throttlerOf(deps).consume('recovery:client', input.clientKey, deps.config.throttle)
    await throttlerOf(deps).consume('recovery:email', email, deps.config.throttle)
    const user = await deps.config.users.findByEmail(email)
    if (!user) return

    const token = generateToken(deps.config.tokenSecretLength)
    const operationId = randomUUID()
    const now = DateTime.utc()
    const { value: issuedUser, fault } = await settleCommitted(
      transaction(deps.db, async (trx) => {
        await lockUser(trx, deps.config, user.id)
        const current = await deps.config.users.findById(user.id, trx)
        if (!current || current.email !== email) return null
        await trx
          .table('password_reset_tokens')
          .insert({
            tokenable_id: current.id,
            email: current.email,
            hash: hashToken(token),
            expires_at: expiresAt(now, deps.config.expiresIn.passwordReset).toISO(),
            created_at: now.toISO(),
          })
          .onConflict('tokenable_id')
          .merge(['email', 'hash', 'expires_at', 'created_at'])
        await deps.config.onPasswordResetIssuedTransaction?.(current, trx)
        return current
      })
    )
    if (!issuedUser) {
      if (fault) throw fault
      return
    }

    await finishCommitted(fault, 'Recovery committed but follow-ups failed', () =>
      postCommit('Recovery follow-up failed', [
        {
          kind: 'delivery',
          run: () =>
            deps.config.notify.passwordResetProvision(
              issuedUser,
              deps.config.urls.passwordReset(token)
            ),
        },
        lifecycle(deps.config, {
          type: 'password_reset.requested',
          userId: issuedUser.id,
          operationId,
        }),
      ])
    )
  } finally {
    // Every exit, including a throw, waits out the configured floor.
    await waitForFloor(started, deps.config.minRequestMs)
  }
}
