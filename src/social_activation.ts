import { DeliveryError, PostCommitError } from './errors.js'
import { sendVerification } from './verification.js'
import type { ServiceDependencies } from './service_dependencies.js'
import type { UserId } from './types.js'

/** Issue activation after social signup; even a pre-issuance failure follows a committed signup. */
export async function sendSocialActivation(
  deps: ServiceDependencies,
  userId: UserId
): Promise<void> {
  try {
    await sendVerification(deps, { userId })
  } catch (cause) {
    if (cause instanceof DeliveryError || cause instanceof PostCommitError) throw cause
    throw new PostCommitError('Social signup committed but activation issuance failed', { cause })
  }
}
