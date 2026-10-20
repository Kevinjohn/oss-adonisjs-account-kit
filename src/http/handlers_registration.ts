/** Managed handler for the registration capability: public signup followed by login. */
import { EmailAlreadyRegisteredError } from '../errors.js'
import type { CurrentAccount } from '../types.js'
import type { ManagedEndpointName } from './routes.js'
import type { ManagedHandler, ManagedRequest } from './managed_types.js'
import {
  passwordPolicyError,
  recoveryDiagnostic,
  reportCommittedFailure,
  ruleError,
  signInLabel,
} from './response_helpers.js'
import { signupValidator } from './validators.js'

async function signup<Credential>({
  route,
  context,
  kit,
  options,
  representIssued,
}: ManagedRequest<Credential>): Promise<unknown> {
  const { request, response } = context
  kit.managedHttp.assertPublicRegistration()
  await kit.managedHttp.consume({ endpoint: route.name, clientKey: request.ip() })
  const input = options.extensions?.registration
    ? await options.extensions.registration.validate(context)
    : await request.validateUsing(signupValidator)
  if (!kit.managedHttp.passwordAllowed(input.password))
    return passwordPolicyError(context, 'password')
  try {
    await kit.registration.register({
      email: input.email,
      password: input.password,
      registrationData: 'registrationData' in input ? input.registrationData : undefined,
    })
  } catch (error) {
    if (error instanceof EmailAlreadyRegisteredError)
      return ruleError(context, 'email', 'unique', 'The email has already been taken.')
    if (!reportCommittedFailure(context, route.name, error)) throw error
  }
  let result: { account: CurrentAccount; credential: Credential }
  try {
    result = await kit.authentication.login(
      {
        email: input.email,
        password: input.password,
        clientKey: request.ip(),
        sessionLabel: signInLabel(context),
      },
      options.guard.forRequest(context)
    )
  } catch {
    recoveryDiagnostic(context, route.name, 'authentication_failed')
    return response.created({ registered: true, authenticated: false })
  }
  return response.created({
    account: await representIssued(result.account),
    ...(options.guard.strategy === 'access_tokens'
      ? { token: options.guard.publicCredential!(result.credential) }
      : {}),
  })
}

export const registrationHandlers = {
  'auth.signup': signup,
} satisfies Partial<Record<ManagedEndpointName, ManagedHandler>>
