// The revision a committed password change wrote, kept for a follow-up failure it then threw.
import { isCommittedFailure } from './errors.ts'
import type { E_ACCOUNT_KIT } from './errors.ts'

const credentialRevisionsByError = new WeakMap<InstanceType<typeof E_ACCOUNT_KIT>, string | null>()

/** Remember the committed revision on a delivery or post-commit error a password change throws. */
export function rememberPasswordChangeRevision(error: unknown, revision: string | null): void {
  if (isCommittedFailure(error)) credentialRevisionsByError.set(error, revision)
}

/**
 * The credential revision a password change committed before a follow-up failed, read from the
 * `E_ACCOUNT_KIT_DELIVERY` or `E_ACCOUNT_KIT_POST_COMMIT` it threw; `undefined` for any other error. Store it where
 * the guard reads the revision, as with the value `changePassword` returns, so the session that
 * changed the password stays signed in.
 *
 * @example
 * ```ts
 * import { passwordChangeRevision } from '@kevinjohn/adonisjs-account-kit'
 *
 * const revision = passwordChangeRevision(error)
 * if (revision !== undefined) await sessionGuard.refresh?.(revision)
 * ```
 */
export function passwordChangeRevision(error: unknown): string | null | undefined {
  return isCommittedFailure(error) ? credentialRevisionsByError.get(error) : undefined
}
