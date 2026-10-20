// The revision a committed password change wrote, kept for a follow-up failure it then threw.
import { PostCommitError } from './errors.js'

const revisions = new WeakMap<PostCommitError, string | null>()

/** Remember the committed revision on the `PostCommitError` a password change throws. */
export function rememberPasswordChangeRevision(error: unknown, revision: string | null): void {
  if (error instanceof PostCommitError) revisions.set(error, revision)
}

/**
 * The credential revision a password change committed before a follow-up failed, read from the
 * `PostCommitError` it threw; `undefined` for any other error. Store it where the guard reads the
 * revision, as with the value `changePassword` returns, so the session that changed the password
 * stays signed in.
 */
export function passwordChangeRevision(error: unknown): string | null | undefined {
  return error instanceof PostCommitError ? revisions.get(error) : undefined
}
