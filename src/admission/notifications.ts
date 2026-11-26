// Delivers admission events to `onAdmissionNotification` after commit.
import { finishCommitted, postCommit, settleCommitted } from '../effects.ts'
import type { AdmissionNotification, ResolvedAdmissionConfig } from './types.ts'

/**
 * Await a committed admission transaction, then report `event` (when there is one). A failing hook
 * surfaces as `E_ACCOUNT_KIT_POST_COMMIT` with the change committed, like every core operation.
 */
export async function withAdmissionNotification<T>(
  config: ResolvedAdmissionConfig,
  pending: Promise<T>,
  event: (value: T) => AdmissionNotification | null
): Promise<T> {
  const { value, fault } = await settleCommitted(pending)
  const happened = event(value)
  await finishCommitted(fault, 'Admission committed but follow-ups failed', () =>
    postCommit('Admission follow-up failed', [
      {
        kind: 'observer',
        run: () => (happened ? config.onAdmissionNotification?.(happened) : undefined),
      },
    ])
  )
  return value
}
