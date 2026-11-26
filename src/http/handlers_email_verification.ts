/** Managed handlers for the email verification capability: link inspection, completion and resend. */
import type { ManagedEndpointName } from './routes.ts'
import type { ManagedHandler } from './managed_types.ts'
import { sendInvalidProofResponse, sendPasswordPolicyErrorResponse } from './response_helpers.ts'
import { newPasswordValidator } from './validators.ts'

export const emailVerificationHandlers = {
  'auth.emailVerification.inspect': async ({ context, kit, options }) =>
    (await kit.emailVerification.inspect({ token: context.params.token }))
      ? context.response.ok({ valid: true })
      : sendInvalidProofResponse(context, 'email', options.extensions?.message),
  'auth.emailVerification.complete': async ({ context, kit }) => {
    const { request, response, params } = context
    const { password } = await request.validateUsing(newPasswordValidator)
    if (!kit.managedHttp.passwordAllowed(password))
      return sendPasswordPolicyErrorResponse(context, 'password')
    await kit.emailVerification.complete({ token: params.token, password })
    return response.ok({ verified: true })
  },
  'account.emailVerification.send': async ({ context, kit, actorId }) => {
    const result = await kit.emailVerification.send({ userId: actorId! })
    return context.response.ok({ result })
  },
} satisfies Partial<Record<ManagedEndpointName, ManagedHandler>>
