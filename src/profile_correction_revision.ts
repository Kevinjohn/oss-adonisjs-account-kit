// The revision an address correction on an unconfirmed account committed, for the caller's session.
const revisions = new WeakMap<object, string | null>()

/** Remember the revision a correction committed on the account it returned or the error it threw. */
export function rememberCorrectionRevision(value: object, revision: string | null): void {
  revisions.set(value, revision)
}

/**
 * The committed revision for a correction's result or follow-up error; `undefined` otherwise.
 * Reading it clears it, so an adapter that returns the same object again cannot replay it.
 */
export function correctionRevision(value: unknown): string | null | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const revision = revisions.get(value)
  revisions.delete(value)
  return revision
}
