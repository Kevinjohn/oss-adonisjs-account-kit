import { performance } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'
import { DateTime } from 'luxon'
import { safeTiming } from '@adonisjs/core/helpers'
import type { Database } from '@adonisjs/lucid/database'
import type { LimiterService } from '@adonisjs/limiter/types'
import { consumeRecoveryToken, lockUser, transaction } from './db.js'
import { normaliseEmail, isEmailShaped } from './email.js'
import { DeliveryError, InvalidInputError, InvalidTokenError, PostCommitError } from './errors.js'
import { consume } from './throttle.js'
import { generateToken, hashToken, isTokenShaped } from './tokens.js'
import { expiresAt } from './ttl.js'
import type {
  AccountUser,
  RecoveryInspectInput,
  RecoveryRequestInput,
  RecoveryResetInput,
  ResolvedConfig,
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
  if (
    typeof input.password !== 'string' ||
    input.password.length < 8 ||
    input.password.length > 255
  )
    throw new InvalidInputError('Invalid password')
  if (!isTokenShaped(input.token)) throw new InvalidTokenError()

  const user = await transaction(deps.db, async (trx) => {
    const row = await consumeRecoveryToken(trx, hashToken(input.token), DateTime.utc().toISO())
    if (!row) throw new InvalidTokenError()
    await lockUser(trx, row.user_id)
    const current = await deps.config.users.findById(row.user_id, trx, { forUpdate: true })
    if (!current || current.email !== row.email) throw new InvalidTokenError()

    await deps.config.users.setPassword(row.user_id, input.password, trx)
    if (current.emailVerifiedAt === null)
      await deps.config.users.markEmailVerified(row.user_id, DateTime.utc(), trx)
    await trx.from('account_email_changes').where('user_id', row.user_id).delete()
    const reloaded = await deps.config.users.findById(row.user_id, trx)
    if (!reloaded) throw new InvalidTokenError()
    return reloaded
  })

  try {
    await deps.config.onCredentialsChanged?.(user)
  } catch (cause) {
    throw new PostCommitError('Credentials changed but the callback failed', { cause })
  }
  return user
}

export async function requestRecovery(
  deps: { config: ResolvedConfig; db: Database; limiter: LimiterService },
  input: RecoveryRequestInput
): Promise<void> {
  const started = performance.now()
  try {
    return await safeTiming(deps.config.minRequestMs, async () => {
      if (!isEmailShaped(input.email)) throw new InvalidInputError('Invalid email')
      const email = normaliseEmail(input.email)

      await consume(deps.limiter, 'recovery:client', input.clientKey, deps.config.throttle)
      await consume(deps.limiter, 'recovery:email', email, deps.config.throttle)
      const user = await deps.config.users.findByEmail(email)
      if (!user) return

      const token = generateToken()
      const now = DateTime.utc()
      await transaction(deps.db, async (trx) => {
        await trx
          .table('account_recovery_tokens')
          .insert({
            user_id: user.id,
            email: user.email,
            token_hash: hashToken(token),
            expires_at: expiresAt(now, deps.config.ttl.recovery).toISO(),
            created_at: now.toISO(),
          })
          .onConflict('user_id')
          .merge(['email', 'token_hash', 'expires_at', 'created_at'])
      })

      try {
        await deps.config.notify.recovery(user, deps.config.urls.recovery(token))
      } catch (cause) {
        throw new DeliveryError('Recovery notification failed', { cause })
      }
    })
  } finally {
    let remaining = deps.config.minRequestMs - (performance.now() - started)
    while (remaining > 0) {
      await delay(Math.ceil(remaining))
      remaining = deps.config.minRequestMs - (performance.now() - started)
    }
  }
}
