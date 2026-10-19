import { committedResult } from './transaction.js'
import { DeliveryError, PostCommitError } from './errors.js'
import type { LifecycleEvent, ResolvedConfig } from './types.js'

export interface PostCommitEffect {
  kind: 'delivery' | 'observer'
  run: () => Promise<void> | undefined
}

/** Attempt independent follow-ups in order without replaying a committed transaction. */
export async function postCommit(message: string, effects: PostCommitEffect[]): Promise<void> {
  const failures: unknown[] = []
  let observerFailed = false
  for (const effect of effects) {
    try {
      await effect.run()
    } catch (cause) {
      failures.push(cause)
      observerFailed ||= effect.kind === 'observer'
    }
  }
  if (failures.length === 0) return
  const cause = failures.length === 1 ? failures[0] : new AggregateError(failures)
  if (observerFailed) throw new PostCommitError(message, { cause })
  throw new DeliveryError(message, { cause })
}

/** Send a notification after commit; a failure surfaces as DeliveryError. */
export async function deliver(message: string, send: () => Promise<void>): Promise<void> {
  try {
    await send()
  } catch (cause) {
    throw new DeliveryError(message, { cause })
  }
}

const observer = (run: PostCommitEffect['run']): PostCommitEffect => ({ kind: 'observer', run })

/**
 * Run post-commit effects in order. Every effect runs even when an earlier one fails, and the
 * failures are reported together as one PostCommitError.
 */
export async function afterCommit(
  message: string,
  ...effects: Array<() => Promise<void> | undefined>
): Promise<void> {
  return postCommit(message, effects.map(observer))
}

/** Report a lifecycle event after commit; a failing hook surfaces as PostCommitError. */
export function lifecycle(
  config: Pick<ResolvedConfig, 'onLifecycleEvent'>,
  event: LifecycleEvent
): PostCommitEffect {
  return observer(() => config.onLifecycleEvent?.(event))
}

/** Await a package transaction; a committed fault still yields its result. */
export async function settleCommitted<T>(
  pending: Promise<T>
): Promise<{ value: T; fault?: PostCommitError }> {
  try {
    return { value: await pending }
  } catch (error) {
    const saved = committedResult<T>(error)
    if (!saved) throw error
    return { value: saved.value, fault: error as PostCommitError }
  }
}

/** Run follow-ups, then rethrow a committed fault combined with any follow-up failure. */
export async function finishCommitted(
  fault: PostCommitError | undefined,
  message: string,
  followUps: () => Promise<void>
): Promise<void> {
  try {
    await followUps()
  } catch (error) {
    if (!fault) throw error
    throw new PostCommitError(message, {
      cause: new AggregateError([fault.cause, (error as Error).cause ?? error]),
    })
  }
  if (fault) throw fault
}
