// The revision an address correction on an unconfirmed account committed, for the caller's session.
const revisions = new WeakMap<object, string | null>()

/** Remember the revision a correction committed on the account it returned or the error it threw. */
export function rememberCorrectionRevision(value: object, revision: string | null): void {
  revisions.set(value, revision)
}

/** The committed revision for a correction's result or follow-up error; `undefined` otherwise. */
export function correctionRevision(value: unknown): string | null | undefined {
  return value !== null && typeof value === 'object' ? revisions.get(value) : undefined
}
