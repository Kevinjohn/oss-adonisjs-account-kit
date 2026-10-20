// Delivers admission events to `onAdmissionEvent` after commit.
import { finishCommitted, postCommit, settleCommitted } from '../effects.js'
import type { AdmissionEvent, ResolvedAdmissionConfig } from './types.js'

/**
 * Await a committed admission transaction, then report `event` (when there is one). A failing hook
 * surfaces as `PostCommitError` with the change committed, like every core operation.
 */
export async function withAdmissionEvent<T>(
  config: ResolvedAdmissionConfig,
  pending: Promise<T>,
  event: (value: T) => AdmissionEvent | null
): Promise<T> {
  const { value, fault } = await settleCommitted(pending)
  const happened = event(value)
  await finishCommitted(fault, 'Admission committed but follow-ups failed', () =>
    postCommit('Admission follow-up failed', [
      {
        kind: 'observer',
        run: () => (happened ? config.onAdmissionEvent?.(happened) : undefined),
      },
    ])
  )
  return value
}
