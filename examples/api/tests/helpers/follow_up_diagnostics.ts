import { followUpFailureChannel } from '#services/committed_failure_diagnostic'

/** Observe only the safe diagnostic payload emitted by a real HTTP request. */
export async function captureFollowUpDiagnostics<T>(run: () => Promise<T>) {
  const entries: unknown[] = []
  const listener = (message: unknown) => entries.push(message)
  followUpFailureChannel.subscribe(listener)
  try {
    return { result: await run(), entries }
  } finally {
    followUpFailureChannel.unsubscribe(listener)
  }
}
