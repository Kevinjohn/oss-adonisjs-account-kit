/** Managed handlers for the email verification capability: link inspection, completion and resend. */
import type { ManagedEndpointName } from './routes.js'
import type { ManagedHandler } from './managed_types.js'
import { invalidProof, passwordPolicyError } from './response_helpers.js'
import { passwordResetCompleteValidator } from './validators.js'

export const emailVerificationHandlers = {
  'auth.emailVerification.inspect': async ({ context, kit, options }) =>
    (await kit.emailVerification.inspect({ token: context.params.token }))
      ? context.response.ok({ valid: true })
      : invalidProof(context, 'email', options.extensions?.message),
  'auth.emailVerification.complete': async ({ context, kit }) => {
    const { request, response, params } = context
    const { password } = await request.validateUsing(passwordResetCompleteValidator)
    if (!kit.managedHttp.passwordAllowed(password)) return passwordPolicyError(context, 'password')
    await kit.emailVerification.complete({ token: params.token, password })
    return response.ok({ verified: true })
  },
  'account.emailVerification.send': async ({ context, kit, actorId }) => {
    const result = await kit.emailVerification.send({ userId: actorId! })
    return context.response.ok({ result })
  },
} satisfies Partial<Record<ManagedEndpointName, ManagedHandler>>
