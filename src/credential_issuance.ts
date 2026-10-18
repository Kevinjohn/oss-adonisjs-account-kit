// Issues a guard credential after a verified sign-in and re-checks the account under its lock.
import type { Database } from '@adonisjs/lucid/database'
import { revision } from './authentication.js'
import { lockUser, transaction } from './db.js'
import { InvalidCredentialsError } from './errors.js'
import type {
  AuthenticationGuard,
  CurrentAccount,
  ResolvedAuthenticationConfig,
  ResolvedConfig,
} from './types.js'

/**
 * Establish the credential for an account whose sign-in proof was verified at `verified.revision`.
 * Adonis token issuance and session writes do not share the package transaction, so a
 * post-issuance lock closes the gap before the credential is returned. Any failure terminates the
 * credential.
 */
export async function establishCredential<Credential>(
  deps: { config: ResolvedConfig; db: Database },
  auth: ResolvedAuthenticationConfig,
  guard: AuthenticationGuard<Credential>,
  verified: { account: CurrentAccount; revision: string | null; email: string }
): Promise<{ account: CurrentAccount; credential: Credential }> {
  let credential: Credential | undefined
  try {
    credential =
      guard.strategy === 'session'
        ? await guard.establish(verified.account.id, verified.revision)
        : await guard.establish(verified.account.id, auth.tokenAbilities, auth.tokenExpiresIn)
    await transaction(deps.db, async (trx) => {
      await lockUser(trx, deps.config, verified.account.id)
      const user = await deps.config.users.findById(verified.account.id, trx)
      if (
        !user ||
        user.email !== verified.email ||
        (await revision(trx, deps.config, user.id)) !== verified.revision ||
        !(await auth.canAccess(user, trx))
      )
        throw new InvalidCredentialsError()
    })
    return { account: verified.account, credential }
  } catch (error) {
    try {
      await guard.terminate(credential)
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Login failed and credential cleanup failed')
    }
    throw error
  }
}
