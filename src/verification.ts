import type { Encryption } from '@adonisjs/core/encryption'
import type { Database } from '@adonisjs/lucid/database'
import type { LimiterService } from '@adonisjs/limiter/types'
import { DateTime } from 'luxon'
import { lockRow, transaction } from './db.js'
import { deliver } from './effects.js'
import { InvalidInputError, InvalidTokenError } from './errors.js'
import { consume } from './throttle.js'
import type { ResolvedConfig, VerificationCompleteInput, VerificationSendInput } from './types.js'

const VERIFICATION_PURPOSE = 'account-kit:verify-email'

export async function sendVerification(
  deps: { config: ResolvedConfig; encryption: Encryption; limiter: LimiterService },
  input: VerificationSendInput
): Promise<'sent' | 'already_verified'> {
  const user = await deps.config.users.findById(input.userId)
  if (!user) throw new InvalidInputError('Unknown user')
  if (user.emailVerifiedAt !== null) return 'already_verified'

  await consume(deps.limiter, 'verification:user', String(user.id), deps.config.throttle)
  const token = deps.encryption.encrypt(
    { userId: user.id, email: user.email },
    deps.config.ttl.verification,
    VERIFICATION_PURPOSE
  )
  await deliver('Verification notification failed', () =>
    deps.config.notify.verification(user, deps.config.urls.verification(token))
  )
  return 'sent'
}

export async function completeVerification(
  deps: { config: ResolvedConfig; db: Database; encryption: Encryption },
  input: VerificationCompleteInput
): Promise<'verified' | 'already_verified'> {
  if (typeof input.token !== 'string') throw new InvalidTokenError()
  const payload: unknown = deps.encryption.decrypt(input.token, VERIFICATION_PURPOSE)
  if (!payload || typeof payload !== 'object' || Array.isArray(payload))
    throw new InvalidTokenError()
  const { userId, email } = payload as { userId?: unknown; email?: unknown }
  if ((typeof userId !== 'number' && typeof userId !== 'string') || typeof email !== 'string')
    throw new InvalidTokenError()

  return transaction(deps.db, async (trx) => {
    await lockRow(trx, deps.config.usersTable, userId)
    const user = await deps.config.users.findById(userId, trx, { forUpdate: true })
    if (!user || user.email !== email) throw new InvalidTokenError()
    if (user.emailVerifiedAt !== null) return 'already_verified'
    await deps.config.users.markEmailVerified(user.id, DateTime.utc(), trx)
    return 'verified'
  })
}
