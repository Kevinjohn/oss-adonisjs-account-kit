import { getCommittedResult } from './transaction.js'
import {
  E_ACCOUNT_KIT_COMMITTED_EFFECTS_FAILED,
  E_ACCOUNT_KIT_COMMITTED_TRANSACTION_FAILED,
  E_ACCOUNT_KIT_DELIVERY,
  E_ACCOUNT_KIT_POST_COMMIT,
} from './errors.js'
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
  const cause =
    failures.length === 1 ? failures[0] : new E_ACCOUNT_KIT_COMMITTED_EFFECTS_FAILED(failures)
  if (observerFailed) throw new E_ACCOUNT_KIT_POST_COMMIT(message, { cause })
  throw new E_ACCOUNT_KIT_DELIVERY(message, { cause })
}

/** Send a notification after commit; a failure surfaces as E_ACCOUNT_KIT_DELIVERY. */
export async function deliver(message: string, send: () => Promise<void>): Promise<void> {
  try {
    await send()
  } catch (cause) {
    throw new E_ACCOUNT_KIT_DELIVERY(message, { cause })
  }
}

const observer = (run: PostCommitEffect['run']): PostCommitEffect => ({ kind: 'observer', run })

/** Report a lifecycle event after commit; a failing hook surfaces as E_ACCOUNT_KIT_POST_COMMIT. */
export function createLifecycleEffect(
  config: Pick<ResolvedConfig, 'onLifecycleEvent'>,
  event: LifecycleEvent
): PostCommitEffect {
  return observer(() => config.onLifecycleEvent?.(event))
}

/** Await a package transaction; a committed fault still yields its result. */
export async function settleCommitted<T>(
  pending: Promise<T>
): Promise<{ value: T; fault?: InstanceType<typeof E_ACCOUNT_KIT_POST_COMMIT> }> {
  try {
    return { value: await pending }
  } catch (error) {
    const saved = getCommittedResult<T>(error)
    if (!saved) throw error
    return { value: saved.value, fault: error as InstanceType<typeof E_ACCOUNT_KIT_POST_COMMIT> }
  }
}

/** Run follow-ups, then rethrow a committed fault combined with any follow-up failure. */
export async function finishCommitted(
  fault: InstanceType<typeof E_ACCOUNT_KIT_POST_COMMIT> | undefined,
  message: string,
  followUps: () => Promise<void>
): Promise<void> {
  try {
    await followUps()
  } catch (error) {
    if (!fault) throw error
    const cause =
      (error instanceof E_ACCOUNT_KIT_DELIVERY || error instanceof E_ACCOUNT_KIT_POST_COMMIT) &&
      'cause' in error
        ? error.cause
        : error
    const followUpFailures =
      cause instanceof E_ACCOUNT_KIT_COMMITTED_EFFECTS_FAILED ? cause.errors : [cause]
    throw new E_ACCOUNT_KIT_COMMITTED_TRANSACTION_FAILED(message, {
      cause: new E_ACCOUNT_KIT_COMMITTED_EFFECTS_FAILED([fault.cause, ...followUpFailures]),
    })
  }
  if (fault) throw fault
}
