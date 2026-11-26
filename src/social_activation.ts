import { isCommittedFailure, E_ACCOUNT_KIT_POST_COMMIT } from './errors.ts'
import { sendVerification } from './verification.ts'
import type { ServiceDependencies } from './service_dependencies.ts'
import type { UserId } from './types.ts'

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
