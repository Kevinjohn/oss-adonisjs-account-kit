import { performance } from 'node:perf_hooks'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { DateTime } from 'luxon'
import type { Database } from '@adonisjs/lucid/database'
import type { LimiterService } from '@adonisjs/limiter/types'
import { consumeUserToken, lockUser, transaction } from './db.js'
import { afterCommit, finishCommitted, postCommit, settleCommitted } from './effects.js'
import { normaliseEmail, isEmailShaped } from './email.js'
import { InvalidInputError, InvalidTokenError } from './errors.js'
import { isPasswordShaped } from './password.js'
import { consume } from './throttle.js'
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
  db: Database,
  input: PasswordResetInspectInput
): Promise<boolean> {
  if (!isTokenShaped(input.token)) return false
  const row = await db
    .from('password_reset_tokens')
    .select(db.raw('1'))
    .where('token_hash', hashToken(input.token))
    .where('expires_at', '>', DateTime.utc().toISO())
    .first()
  return row !== null
}

export async function completePasswordReset(
  deps: { config: ResolvedConfig; db: Database },
  input: PasswordResetCompleteInput
): Promise<AccountUser> {
  if (!isPasswordShaped(input.password)) throw new InvalidInputError('Invalid password')
  if (!isTokenShaped(input.token)) throw new InvalidTokenError()
  const operationId = randomUUID()

  const { value: user, fault } = await settleCommitted(
    transaction(deps.db, async (trx) => {
      const { row, user: current } = await consumeUserToken<{ user_id: UserId; email: string }>(
        trx,
        deps.config,
        'password_reset_tokens',
        input.token,
        (candidate) => candidate.email
      )

      await deps.config.users.setPassword(row.user_id, input.password, trx)
      if (current.emailVerifiedAt === null)
        await deps.config.users.markEmailVerified(row.user_id, DateTime.utc(), trx)
      await trx.from('account_email_changes').where('user_id', row.user_id).delete()
      const reloaded = await deps.config.users.findById(row.user_id, trx)
      if (!reloaded) throw new InvalidTokenError()
      await deps.config.onCredentialsChangedTransaction?.(
        reloaded,
        { operation: 'password_reset', operationId, userId: reloaded.id },
        trx
      )
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
  deps: { config: ResolvedConfig; db: Database; limiter: LimiterService },
  input: PasswordResetRequestInput
): Promise<void> {
  const started = performance.now()
  try {
    if (!isEmailShaped(input.email)) throw new InvalidInputError('Invalid email')
    if (typeof input.clientKey !== 'string' || input.clientKey.trim() === '')
      throw new InvalidInputError('Invalid client key')
    const email = normaliseEmail(input.email)

    await consume(
      deps.limiter,
      'recovery:client',
      input.clientKey,
      deps.config.throttle,
      deps.config.limiterSecret,
      deps.config.limiterNamespace
    )
    await consume(
      deps.limiter,
      'recovery:email',
      email,
      deps.config.throttle,
      deps.config.limiterSecret,
      deps.config.limiterNamespace
    )
    const user = await deps.config.users.findByEmail(email)
    if (!user) return

    const token = generateToken()
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
            user_id: current.id,
            email: current.email,
            token_hash: hashToken(token),
            expires_at: expiresAt(now, deps.config.expiresIn.passwordReset).toISO(),
            created_at: now.toISO(),
          })
          .onConflict('user_id')
          .merge(['email', 'token_hash', 'expires_at', 'created_at'])
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
        {
          kind: 'observer',
          run: () =>
            deps.config.onLifecycleEvent?.({
              type: 'password_reset.requested',
              userId: issuedUser.id,
              operationId,
            }),
        },
      ])
    )
  } finally {
    // Every exit, including a throw, waits out the configured floor. Timers can wake early,
    // so keep waiting until the floor has actually passed.
    let remaining = deps.config.minRequestMs - (performance.now() - started)
    while (remaining > 0) {
      await delay(Math.ceil(remaining))
      remaining = deps.config.minRequestMs - (performance.now() - started)
    }
  }
}
