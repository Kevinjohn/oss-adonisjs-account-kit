import { performance } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'
import { DateTime } from 'luxon'
import { safeTiming } from '@adonisjs/core/helpers'
import type { Database } from '@adonisjs/lucid/database'
import type { LimiterService } from '@adonisjs/limiter/types'
import { transaction } from './db.js'
import { normaliseEmail, isEmailShaped } from './email.js'
import { DeliveryError, InvalidInputError } from './errors.js'
import { consume } from './throttle.js'
import { generateToken, hashToken } from './tokens.js'
import { expiresAt } from './ttl.js'
import type { RecoveryRequestInput, ResolvedConfig } from './types.js'

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
