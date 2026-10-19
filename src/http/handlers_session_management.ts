/** Managed handlers for session management: list sign-ins, revoke one, others, or all. */
import { DeliveryError, PostCommitError } from '../errors.js'
import { revocationOutcome } from '../session_revocation.js'
import type { ManagedEndpointName } from './routes.js'
import type { ManagedHandler } from './managed.js'
import { endSessionAfterCommit } from './session_end.js'

export const sessionManagementHandlers = {
  'account.sessions.list': async ({ context, kit, accountInput }) =>
    context.response.ok({
      sessions: await kit.authentication.sessions.list({ current: accountInput! }),
    }),
  'account.sessions.revoke': async ({ context, kit, options, accountInput, route }) => {
    let result: { current: boolean }
    try {
      result = await kit.authentication.sessions.revoke({
        current: accountInput!,
        id: context.params.id,
      })
    } catch (error) {
      // The revocation committed; end this session before reporting the follow-up failure.
      if (revocationOutcome(error)?.current)
        await endSessionAfterCommit(options.guard, context, route.name)
      throw error
    }
    if (result.current) await endSessionAfterCommit(options.guard, context, route.name)
    return context.response.noContent()
  },
  'account.sessions.revokeOthers': async ({ context, kit, accountInput }) =>
    context.response.ok(await kit.authentication.sessions.revokeOthers({ current: accountInput! })),
  'account.sessions.revokeAll': async ({ context, kit, options, accountInput, route }) => {
    try {
      await kit.authentication.sessions.revokeAll({ current: accountInput! })
    } catch (error) {
      // Everything was signed out even though a follow-up failed; end this session too.
      if (error instanceof PostCommitError || error instanceof DeliveryError)
        await endSessionAfterCommit(options.guard, context, route.name)
      throw error
    }
    await endSessionAfterCommit(options.guard, context, route.name)
    return context.response.noContent()
  },
} satisfies Partial<Record<ManagedEndpointName, ManagedHandler>>
