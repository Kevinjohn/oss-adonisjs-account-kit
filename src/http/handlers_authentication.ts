/** Managed handlers for the authentication capability: CSRF token, login, logout and profile read. */
import type { ManagedEndpointName } from './routes.js'
import type { ManagedHandler } from './managed.js'
import { rememberManagedMethod } from './last_used_method.js'
import { signInLabel } from './response_helpers.js'
import { loginValidator } from './validators.js'

export const authenticationHandlers = {
  'auth.csrf': async ({ context, csrfToken }) => {
    const { response } = context
    response.header('Cache-Control', 'no-store')
    return response.ok({ csrfToken })
  },
  'auth.login': async ({ context, kit, options, methodsEnabled, representIssued }) => {
    const { request, response } = context
    const { email, password } = await request.validateUsing(loginValidator)
    const result = await kit.authentication.login(
      { email, password, clientKey: request.ip(), sessionLabel: signInLabel(context) },
      options.guard.forRequest(context)
    )
    if (methodsEnabled) await rememberManagedMethod(context, 'password', options.extensions?.social)
    return response.ok({
      account: await representIssued(result.account),
      ...(options.guard.strategy === 'access_tokens'
        ? { token: options.guard.publicCredential!(result.credential) }
        : {}),
    })
  },
  'account.logout': async ({ context, kit, options, accountInput }) => {
    await kit.authentication.logout(
      options.guard.forRequest(context),
      await options.guard.logoutCredential?.(context),
      accountInput
    )
    return context.response.noContent()
  },
  'account.profile.show': async ({ context, account, represent }) =>
    context.response.ok({ account: await represent(account!) }),
} satisfies Partial<Record<ManagedEndpointName, ManagedHandler>>
