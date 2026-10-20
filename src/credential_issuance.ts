// Issues a guard credential after a verified sign-in and re-checks the account under its lock.
import { revision } from './credential_revision.js'
import { lockUser, transaction } from './db.js'
import { newSessionHandle, recordSession, sessionRegistryEnabled } from './session_registry.js'
import type {
  AccountUser,
  AuthenticationGuard,
  CurrentAccount,
  ResolvedAuthenticationConfig,
  Trx,
} from './types.js'
import type { ServiceDependencies } from './service_dependencies.js'

export interface IssuanceOptions {
  /** Untrusted display text for the sign-in list; truncated to 255 characters. */
  label?: string
  /** Extra checks for this sign-in method, run under the post-issuance lock. */
  stillValid?(trx: Trx, user: AccountUser): Promise<boolean>
  /** The error a failed re-check throws. */
  rejected(): Error
  /** Message for the AggregateError when terminating the credential also fails. */
  cleanupFailed: string
}

/**
 * Establish the credential for an account whose sign-in was verified at `verified.revision`.
 * Adonis token issuance and session writes do not share the package transaction, so a
 * post-issuance lock closes the gap before the credential is returned. Session guards with
 * `sessionManagement` receive a fresh handle; only its hash is stored, in that same transaction.
 * Any failure terminates the credential.
 */
export async function establishCredential<Credential>(
  deps: Pick<ServiceDependencies, 'config' | 'db'>,
  auth: ResolvedAuthenticationConfig,
  guard: AuthenticationGuard<Credential>,
  verified: { account: CurrentAccount; revision: string | null },
  options: IssuanceOptions
): Promise<Credential> {
  const label = options.label?.slice(0, 255) || null
  const handle = sessionRegistryEnabled(deps.config) ? newSessionHandle() : undefined
  let credential: Credential | undefined
  try {
    if (guard.strategy === 'session')
      credential = handle
        ? await guard.establish(verified.account.id, verified.revision, handle)
        : await guard.establish(verified.account.id, verified.revision)
    else
      credential = label
        ? await guard.establish(verified.account.id, auth.tokenAbilities, auth.tokenExpiresIn, {
            name: label,
          })
        : await guard.establish(verified.account.id, auth.tokenAbilities, auth.tokenExpiresIn)
    await transaction(deps.db, async (trx) => {
      await lockUser(trx, deps.config, verified.account.id)
      const user = await deps.config.users.findById(verified.account.id, trx)
      if (
        !user ||
        (await revision(trx, deps.config, user.id)) !== verified.revision ||
        (options.stillValid && !(await options.stillValid(trx, user))) ||
        !(await auth.canAccess(user, trx))
      )
        throw options.rejected()
      if (handle) await recordSession(trx, deps.config, user.id, handle, label)
    })
    return credential
  } catch (error) {
    try {
      await guard.terminate(credential)
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], options.cleanupFailed)
    }
    throw error
  }
}
