// Delivers admission events to `onAdmissionEvent` after commit.
import { finishCommitted, postCommit, settleCommitted } from '../effects.ts'
import type { AdmissionEvent, ResolvedAdmissionConfig } from './types.ts'

/**
 * Await a committed admission transaction, then report `event` (when there is one). A failing hook
 * surfaces as `E_ACCOUNT_KIT_POST_COMMIT` with the change committed, like every core operation.
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
