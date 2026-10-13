import type { Encryption } from '@adonisjs/core/encryption'
import type { LimiterService } from '@adonisjs/limiter/types'
import { DeliveryError, InvalidInputError } from './errors.js'
import { consume } from './throttle.js'
import type { ResolvedConfig, VerificationSendInput } from './types.js'

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
    'account-kit:verify-email'
  )
  try {
    await deps.config.notify.verification(user, deps.config.urls.verification(token))
  } catch (cause) {
    throw new DeliveryError('Verification notification failed', { cause })
  }
  return 'sent'
}
