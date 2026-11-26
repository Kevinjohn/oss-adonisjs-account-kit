/** Managed handler for the registration capability: public signup followed by login. */
import { E_ACCOUNT_KIT_EMAIL_ALREADY_REGISTERED } from '../errors.ts'
import type { CurrentAccount } from '../types.ts'
import type { ManagedEndpointName } from './routes.ts'
import type { ManagedHandler, ManagedRequest } from './managed_types.ts'
import {
  renderIssuedAccountBody,
  sendPasswordRulesErrorResponse,
  logRecoveryDiagnostic,
  reportCommittedFailure,
  sendRuleViolationResponse,
  signInLabel,
} from './response_helpers.ts'
import { signupValidator } from './validators.ts'

async function signUp<Credential>({
  route,
  context,
  kit,
  options,
  representIssued,
}: ManagedRequest<Credential>): Promise<unknown> {
  const { request, response } = context
  // The body can carry a bearer token; no cache may keep it.
  response.header('Cache-Control', 'no-store')
  kit.managedHttp.assertPublicRegistration()
  await kit.managedHttp.consume({ endpoint: route.name, clientKey: request.ip() })
  const input = options.extensions?.registration
    ? await options.extensions.registration.validate(context)
    : await request.validateUsing(signupValidator)
  if (!kit.managedHttp.passwordAllowed(input.password))
    return sendPasswordRulesErrorResponse(context, 'password')
  try {
    await kit.registration.register({
      email: input.email,
      password: input.password,
      registrationData: 'registrationData' in input ? input.registrationData : undefined,
    })
  } catch (error) {
    if (error instanceof E_ACCOUNT_KIT_EMAIL_ALREADY_REGISTERED)
      return sendRuleViolationResponse(
        context,
        'email',
        'unique',
        'The email has already been taken.'
      )
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
    logRecoveryDiagnostic(context, route.name, 'authentication_failed')
    return response.created({ registered: true, authenticated: false })
  }
  return response.created(await renderIssuedAccountBody({ options, representIssued }, result))
}

export const registrationHandlers = {
  'auth.signup': signUp,
} satisfies Partial<Record<ManagedEndpointName, ManagedHandler>>
