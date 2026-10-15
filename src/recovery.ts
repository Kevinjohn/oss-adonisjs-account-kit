import { performance } from 'node:perf_hooks'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { DateTime } from 'luxon'
import type { Database } from '@adonisjs/lucid/database'
import type { LimiterService } from '@adonisjs/limiter/types'
import { committedResult, consumeUserToken, lockUser, transaction } from './db.js'
import { afterCommit, postCommit } from './effects.js'
import { normaliseEmail, isEmailShaped } from './email.js'
import { InvalidInputError, InvalidTokenError, PostCommitError } from './errors.js'
import { isPasswordShaped } from './password.js'
import { consume } from './throttle.js'
import { generateToken, hashToken, isTokenShaped } from './tokens.js'
import { expiresAt } from './ttl.js'
import type {
  AccountUser,
  RecoveryInspectInput,
  RecoveryRequestInput,
  RecoveryResetInput,
  ResolvedConfig,
  UserId,
} from './types.js'

export async function inspectRecovery(db: Database, input: RecoveryInspectInput): Promise<boolean> {
  if (!isTokenShaped(input.token)) return false
  const row = await db
    .from('account_recovery_tokens')
    .select(db.raw('1'))
    .where('token_hash', hashToken(input.token))
    .where('expires_at', '>', DateTime.utc().toISO())
    .first()
  return row !== null
}

export async function resetRecovery(
  deps: { config: ResolvedConfig; db: Database },
  input: RecoveryResetInput
): Promise<AccountUser> {
  if (!isPasswordShaped(input.password)) throw new InvalidInputError('Invalid password')
  if (!isTokenShaped(input.token)) throw new InvalidTokenError()
  const operationId = randomUUID()

  let user: AccountUser
  let committedFault: PostCommitError | undefined
  try {
    user = await transaction(deps.db, async (trx) => {
      const { row, user: current } = await consumeUserToken<{ user_id: UserId; email: string }>(
        trx,
        deps.config,
        'account_recovery_tokens',
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
  } catch (error) {
    const saved = committedResult<AccountUser>(error)
    if (!saved) throw error
    user = saved.value
    committedFault = error as PostCommitError
  }

  const context = { operation: 'password_reset' as const, operationId, userId: user.id }
  try {
    await afterCommit(
      'Credentials changed but a follow-up failed',
      () => deps.config.onCredentialsChanged?.(user, context),
      () => deps.config.notify.passwordReset(user, context),
      () => deps.config.onLifecycleEvent?.({ type: 'password.reset', userId: user.id, operationId })
    )
  } catch (error) {
    if (!committedFault) throw error
    throw new PostCommitError('Credentials changed but follow-ups failed', {
      cause: new AggregateError([committedFault.cause, (error as Error).cause ?? error]),
    })
  }
  if (committedFault) throw committedFault
  return user
}

export async function requestRecovery(
  deps: { config: ResolvedConfig; db: Database; limiter: LimiterService },
  input: RecoveryRequestInput
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
    let issuedUser: AccountUser | null
    let committedFault: PostCommitError | undefined
    try {
      issuedUser = await transaction(deps.db, async (trx) => {
        await lockUser(trx, deps.config, user.id)
        const current = await deps.config.users.findById(user.id, trx)
        if (!current || current.email !== email) return null
        await trx
          .table('account_recovery_tokens')
          .insert({
            user_id: current.id,
            email: current.email,
            token_hash: hashToken(token),
            expires_at: expiresAt(now, deps.config.ttl.recovery).toISO(),
            created_at: now.toISO(),
          })
          .onConflict('user_id')
          .merge(['email', 'token_hash', 'expires_at', 'created_at'])
        await deps.config.onRecoveryIssuedTransaction?.(current, trx)
        return current
      })
    } catch (error) {
      const saved = committedResult<AccountUser | null>(error)
      if (!saved) throw error
      issuedUser = saved.value
      committedFault = error as PostCommitError
    }
    if (!issuedUser) {
      if (committedFault) throw committedFault
      return
    }

    try {
      await postCommit('Recovery follow-up failed', [
        {
          kind: 'delivery',
          run: () => deps.config.notify.recovery(issuedUser, deps.config.urls.recovery(token)),
        },
        {
          kind: 'observer',
          run: () =>
            deps.config.onLifecycleEvent?.({
              type: 'recovery.requested',
              userId: issuedUser.id,
              operationId,
            }),
        },
      ])
    } catch (error) {
      if (!committedFault) throw error
      throw new PostCommitError('Recovery committed but follow-ups failed', {
        cause: new AggregateError([committedFault.cause, (error as Error).cause ?? error]),
      })
    }
    if (committedFault) throw committedFault
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
