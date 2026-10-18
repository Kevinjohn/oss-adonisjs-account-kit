// Keeps a revocation's outcome on the committed-fault error, so callers can still end the session.
import { DeliveryError, PostCommitError } from './errors.js'

const outcomes = new WeakMap<Error, { current: boolean }>()

/** Run follow-ups for a committed revocation, tagging any committed fault with its outcome. */
export async function recordRevocation(
  outcome: { current: boolean },
  followUps: () => Promise<void>
): Promise<void> {
  try {
    await followUps()
  } catch (error) {
    if (error instanceof PostCommitError || error instanceof DeliveryError)
      outcomes.set(error, outcome)
    throw error
  }
}

/** The outcome of a revocation that committed before `error` was thrown, if any. */
export function revocationOutcome(error: unknown): { current: boolean } | undefined {
  return error instanceof Error ? outcomes.get(error) : undefined
}
