// Records whether an already committed revocation affected the current session, even when a
// follow-up throws. It does not infer whether a server committed after a lost client response.
import { isCommittedFailure } from './errors.ts'

export class RevocationOutcomes {
  #byError = new WeakMap<Error, { current: boolean }>()

  /** Run follow-ups for a committed revocation, tagging any committed fault with its outcome. */
  async record(outcome: { current: boolean }, followUps: () => Promise<void>): Promise<void> {
    try {
      await followUps()
    } catch (error) {
      if (isCommittedFailure(error)) this.#byError.set(error, outcome)
      throw error
    }
  }

  /** The outcome of a revocation that committed before `error` was thrown, if any. */
  get(error: unknown): { current: boolean } | undefined {
    return error instanceof Error ? this.#byError.get(error) : undefined
  }
}
