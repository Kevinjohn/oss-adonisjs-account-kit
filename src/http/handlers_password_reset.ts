/** Managed handlers for the password reset capability: request, link inspection and completion. */
import { DeliveryError, PostCommitError } from '../errors.js'
import type { ManagedEndpointName } from './routes.js'
import type { ManagedHandler } from './managed_types.js'
import {
  invalidProof,
  passwordPolicyError,
  recoveryDiagnostic,
  translate,
} from './response_helpers.js'
import { newPasswordValidator, passwordResetRequestValidator } from './validators.js'

export const passwordResetHandlers = {
  'auth.passwordReset.request': async ({ route, context, kit }) => {
    const { request, response } = context
    const { email } = await request.validateUsing(passwordResetRequestValidator)
    try {
      await kit.passwordReset.request({ email, clientKey: request.ip() })
    } catch (error) {
      if (!(error instanceof DeliveryError || error instanceof PostCommitError)) throw error
      recoveryDiagnostic(
        context,
        route.name,
        error instanceof DeliveryError ? 'delivery_failed' : 'followup_failed'
      )
    }
    return response.accepted({
      message: translate(
        context,
        'account_kit.password_reset_requested',
        'If the account exists, instructions will be sent.'
      ),
    })
  },
  'auth.passwordReset.inspect': async ({ context, kit, options }) =>
    (await kit.passwordReset.inspect({ token: context.params.token }))
      ? context.response.ok({ valid: true })
      : invalidProof(context, 'password', options.extensions?.message),
  'auth.passwordReset.complete': async ({ context, kit }) => {
    const { request, response, params } = context
    const { password } = await request.validateUsing(newPasswordValidator)
    if (!kit.managedHttp.passwordAllowed(password)) return passwordPolicyError(context, 'password')
    await kit.passwordReset.reset({ token: params.token, password })
    return response.ok({ reset: true })
  },
} satisfies Partial<Record<ManagedEndpointName, ManagedHandler>>
