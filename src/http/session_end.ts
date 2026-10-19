/** Ends the caller's browser session after an account operation has committed. */
import type { HttpContext } from '@adonisjs/core/http'
import type { ManagedEndpointName } from './routes.js'
import type { ManagedGuard } from './managed.js'
import { recoveryDiagnostic } from './response_helpers.js'

/**
 * End the caller's browser session once the operation has committed. Token guards need nothing:
 * the operation already deleted the token. A failure is logged as `session_end_failed`; the
 * committed operation stands and the route still answers as it would have.
 */
export async function endSessionAfterCommit<Credential>(
  guard: ManagedGuard<Credential>,
  context: HttpContext,
  operation: ManagedEndpointName
): Promise<void> {
  if (guard.strategy !== 'session') return
  try {
    await guard.forRequest(context).terminate()
  } catch {
    recoveryDiagnostic(context, operation, 'session_end_failed')
  }
}
