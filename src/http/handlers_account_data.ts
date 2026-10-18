/** Managed handlers for the account export and account deletion capabilities. */
import type { HttpContext } from '@adonisjs/core/http'
import { exportFault } from '../account_export.js'
import { DeliveryError, PostCommitError } from '../errors.js'
import type { ManagedEndpointName } from './routes.js'
import type { ManagedGuard, ManagedHandler } from './managed.js'
import { recoveryDiagnostic } from './response_helpers.js'
import { accountProofValidator } from './validators.js'

/**
 * End the deleted account's browser session. Token guards need nothing: the user's tokens were
 * deleted with the account. A failure is logged; the account is already gone.
 */
async function endSession<Credential>(
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

export const accountDataHandlers = {
  'account.data.export': async ({ context, kit, actorId, route }) => {
    const { currentPassword, recentProof } =
      await context.request.validateUsing(accountProofValidator)
    const document = await kit.accountData.export({
      actorId: actorId!,
      currentPassword,
      recentProof,
    })
    // Only the proof was consumed before the fault; the document is complete, so send it.
    if (exportFault(document)) recoveryDiagnostic(context, route.name, 'followup_failed')
    context.response.header('Cache-Control', 'no-store')
    context.response.header('Content-Disposition', 'attachment; filename="account-export.json"')
    return context.response.ok(document)
  },
  'account.delete': async ({ context, kit, actorId, options, route }) => {
    const { currentPassword, recentProof } =
      await context.request.validateUsing(accountProofValidator)
    try {
      await kit.accountData.delete({ actorId: actorId!, currentPassword, recentProof })
    } catch (error) {
      // The deletion committed even though a follow-up failed; end the session too.
      if (error instanceof PostCommitError || error instanceof DeliveryError)
        await endSession(options.guard, context, route.name)
      throw error
    }
    await endSession(options.guard, context, route.name)
    return context.response.noContent()
  },
} satisfies Partial<Record<ManagedEndpointName, ManagedHandler>>
