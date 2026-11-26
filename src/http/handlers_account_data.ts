/** Managed handlers for the account export and account deletion capabilities. */
import { exportFault } from '../account_export.ts'
import { isCommittedFailure } from '../errors.ts'
import type { ManagedEndpointName } from './routes.ts'
import type { ManagedHandler } from './managed_types.ts'
import { logRecoveryDiagnostic } from './response_helpers.ts'
import { endSessionAfterCommit } from './session_end.ts'
import { accountProofValidator } from './validators.ts'

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
    if (exportFault(document)) logRecoveryDiagnostic(context, route.name, 'followup_failed')
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
      if (isCommittedFailure(error)) await endSessionAfterCommit(options.guard, context, route.name)
      throw error
    }
    await endSessionAfterCommit(options.guard, context, route.name)
    return context.response.noContent()
  },
} satisfies Partial<Record<ManagedEndpointName, ManagedHandler>>
