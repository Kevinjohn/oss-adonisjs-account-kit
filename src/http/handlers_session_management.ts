/** Managed handlers for session management: list sign-ins, revoke one, others, or all. */
import { isCommittedFailure } from '../errors.ts'
import type { ManagedEndpointName } from './routes.ts'
import type { ManagedHandler } from './managed_types.ts'
import { endSessionAfterCommit } from './session_end.ts'

export const sessionManagementHandlers = {
  /** @throws {AggregateError} If transaction work and cleanup fail before a commit is confirmed. */
  'account.sessions.list': async ({ context, kit, accountInput }) =>
    context.response.ok({
      sessions: await kit.authentication.sessions.list({ current: accountInput! }),
    }),
  /** @throws {AggregateError} If transaction work and cleanup fail before a commit is confirmed. */
  'account.sessions.revoke': async ({ context, kit, options, accountInput, route }) => {
    let result: { current: boolean }
    try {
      result = await kit.authentication.sessions.revoke({
        current: accountInput!,
        id: context.params.id,
      })
    } catch (error) {
      // The revocation committed; end this session before reporting the follow-up failure.
      if (kit.managedHttp.revocationOutcome(error)?.current)
        await endSessionAfterCommit(options.guard, context, route.name)
      throw error
    }
    if (result.current) await endSessionAfterCommit(options.guard, context, route.name)
    return context.response.noContent()
  },
  /** @throws {AggregateError} If transaction work and cleanup fail before a commit is confirmed. */
  'account.sessions.revokeOthers': async ({ context, kit, accountInput }) =>
    context.response.ok(await kit.authentication.sessions.revokeOthers({ current: accountInput! })),
  /** @throws {AggregateError} If transaction work and cleanup fail before a commit is confirmed. */
  'account.sessions.revokeAll': async ({ context, kit, options, accountInput, route }) => {
    try {
      await kit.authentication.sessions.revokeAll({ current: accountInput! })
    } catch (error) {
      // Everything was signed out even though a follow-up failed; end this session too.
      if (isCommittedFailure(error)) await endSessionAfterCommit(options.guard, context, route.name)
      throw error
    }
    await endSessionAfterCommit(options.guard, context, route.name)
    return context.response.noContent()
  },
} satisfies Partial<Record<ManagedEndpointName, ManagedHandler>>
