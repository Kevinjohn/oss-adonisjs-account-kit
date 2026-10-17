/** Managed handlers for the email and password management capability: email change, profile, password. */
import type { ManagedEndpointName } from './routes.js'
import type { ManagedHandler } from './managed.js'
import { currentAccount, invalidProof, passwordPolicyError } from './response_helpers.js'
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
    return context.response.ok({ account: await representIssued(currentAccount(user)) })
  },
  'account.profile.update': async ({ context, kit, options, actorId, representIssued }) => {
    const { request, response } = context
    const input = options.extensions?.profile
      ? await options.extensions.profile.validate(context)
      : await request.validateUsing(profileUpdateValidator)
    const user = await kit.emailPasswordManagement.updateProfile({
      actorId: actorId!,
      currentPassword: input.currentPassword,
      recentProof: input.recentProof,
      email: input.email,
      ...('registrationData' in input ? { registrationData: input.registrationData } : {}),
    })
    return response.ok({ account: await representIssued(currentAccount(user)) })
  },
  'account.password.change': async ({ context, kit, actorId }) => {
    const { request, response } = context
    const { currentPassword, recentProof, newPassword } =
      await request.validateUsing(passwordChangeValidator)
    if (!kit.managedHttp.passwordAllowed(newPassword))
      return passwordPolicyError(context, 'newPassword')
    await kit.emailPasswordManagement.changePassword({
      actorId: actorId!,
      currentPassword,
      recentProof,
      newPassword,
    })
    return response.ok({ changed: true })
  },
} satisfies Partial<Record<ManagedEndpointName, ManagedHandler>>
