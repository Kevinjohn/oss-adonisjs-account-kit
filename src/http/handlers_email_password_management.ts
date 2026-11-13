/** Managed handlers for the email and password management capability: email change, profile, password. */
import type { ManagedEndpointName } from './routes.js'
import type { ManagedHandler } from './managed_types.js'
import { safeAccount } from '../account_projection.js'
import { passwordChangeRevision } from '../password_change_revision.js'
import { correctionRevision } from '../profile_correction_revision.js'
import { invalidProof, passwordPolicyError } from './response_helpers.js'
import { passwordChangeValidator, profileUpdateValidator } from './validators.js'

export const emailPasswordManagementHandlers = {
  'auth.emailChange.inspect': async ({ context, kit, options }) =>
    (await kit.emailPasswordManagement.inspectEmailChange({ token: context.params.token }))
      ? context.response.ok({ valid: true })
      : invalidProof(context, 'email', options.extensions?.message),
  'auth.emailChange.complete': async ({ context, kit, representIssued }) => {
    const user = await kit.emailPasswordManagement.completeEmailChange({
      token: context.params.token,
    })
    return context.response.ok({ account: await representIssued(safeAccount(user)) })
  },
  'account.profile.update': async ({
    context,
    kit,
    options,
    actorId,
    accountInput,
    representIssued,
  }) => {
    const { request, response } = context
    const input = options.extensions?.profile
      ? await options.extensions.profile.validate(context)
      : await request.validateUsing(profileUpdateValidator)
    const guard = options.guard.forRequest(context)
    // A new address on an account that is not yet active advances the credential revision; the
    // caller keeps this sign-in, so a session stores the revision the correction committed.
    const keepSession = async (outcome: unknown) => {
      const committed = correctionRevision(outcome)
      if (committed !== undefined && guard.strategy === 'session') await guard.refresh?.(committed)
    }
    const user = await kit.emailPasswordManagement
      .updateProfile({
        actorId: actorId!,
        currentPassword: input.currentPassword,
        recentProof: input.recentProof,
        email: input.email,
        ...('registrationData' in input ? { registrationData: input.registrationData } : {}),
        keepCurrent: {
          ...(accountInput?.sessionHandle === undefined
            ? {}
            : { sessionHandle: accountInput.sessionHandle }),
          ...(accountInput?.tokenId === undefined ? {} : { tokenId: accountInput.tokenId }),
        },
      })
      .catch(async (error: unknown) => {
        // The correction committed; only a follow-up or its message failed.
        await keepSession(error)
        throw error
      })
    await keepSession(user)
    return response.ok({ account: await representIssued(safeAccount(user)) })
  },
  'account.password.change': async ({ context, kit, options, actorId, accountInput }) => {
    const { request, response } = context
    const { currentPassword, recentProof, newPassword } =
      await request.validateUsing(passwordChangeValidator)
    if (!kit.managedHttp.passwordAllowed(newPassword))
      return passwordPolicyError(context, 'newPassword')
    const guard = options.guard.forRequest(context)
    const { revision } = await kit.emailPasswordManagement
      .changePassword({
        actorId: actorId!,
        currentPassword,
        recentProof,
        newPassword,
        keepCurrent: {
          ...(accountInput?.sessionHandle === undefined
            ? {}
            : { sessionHandle: accountInput.sessionHandle }),
          ...(accountInput?.tokenId === undefined ? {} : { tokenId: accountInput.tokenId }),
        },
      })
      .catch(async (error: unknown) => {
        // A follow-up failed after commit: keep this session on the new revision, then report it.
        const committed = passwordChangeRevision(error)
        if (committed !== undefined && guard.strategy === 'session')
          await guard.refresh?.(committed)
        throw error
      })
    if (guard.strategy === 'session') await guard.refresh?.(revision)
    return response.ok({ changed: true })
  },
} satisfies Partial<Record<ManagedEndpointName, ManagedHandler>>
