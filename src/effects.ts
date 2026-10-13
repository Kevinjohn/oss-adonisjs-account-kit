import { DeliveryError, PostCommitError } from './errors.js'

/** Send a notification after commit; a failure surfaces as DeliveryError. */
export async function deliver(message: string, send: () => Promise<void>): Promise<void> {
  try {
    await send()
  } catch (cause) {
    throw new DeliveryError(message, { cause })
  }
}

/**
 * Run post-commit effects in order. Every effect runs even when an earlier one fails, and the
 * failures are reported together as one PostCommitError.
 */
export async function afterCommit(
  message: string,
  ...effects: Array<() => Promise<void> | undefined>
): Promise<void> {
  const failures: unknown[] = []
  for (const effect of effects) {
    try {
      await effect()
    } catch (cause) {
      failures.push(cause)
    }
  }
  if (failures.length > 0) {
    throw new PostCommitError(message, {
      cause: failures.length === 1 ? failures[0] : new AggregateError(failures),
    })
  }
}
