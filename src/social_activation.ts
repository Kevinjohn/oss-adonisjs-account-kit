import { isCommittedFailure, E_ACCOUNT_KIT_POST_COMMIT } from './errors.js'
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
    if (isCommittedFailure(cause)) throw cause
    throw new E_ACCOUNT_KIT_POST_COMMIT('Social signup committed but activation issuance failed', {
      cause,
    })
  }
}
