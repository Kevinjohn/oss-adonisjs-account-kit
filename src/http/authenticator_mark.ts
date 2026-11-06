// Leaves the application's Authenticator authenticated for the guard the package just checked.
import { InvalidSessionError } from '../errors.js'

/** The slice of `ctx.auth` that records which guard authenticated the request. */
export interface MarkableAuthenticator {
  /** `@adonisjs/auth`'s `Authenticator.authenticateUsing`; absent on a bare guard object. */
  authenticateUsing?(guards: string[]): Promise<unknown>
}

/**
 * After `ctx.auth.use(guard).authenticate()` succeeded, mark `ctx.auth` so `ctx.auth.user`,
 * `ctx.auth.isAuthenticated` and `ctx.auth.getUserOrFail()` answer for that guard, as they do after
 * `middleware.auth({ guards: [guard] })`. The guard remembers its attempt, so this does not look
 * the credential up again.
 */
export async function markAuthenticated(auth: MarkableAuthenticator, guard: string): Promise<void> {
  if (typeof auth.authenticateUsing !== 'function') return
  try {
    await auth.authenticateUsing([guard])
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'E_UNAUTHORIZED_ACCESS'
    )
      throw new InvalidSessionError()
    throw error
  }
}
