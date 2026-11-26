import type { HttpContext } from '@adonisjs/core/http'
import type { CurrentAccount } from '../types.ts'
import { E_ACCOUNT_KIT_INVALID_SESSION } from '../errors.ts'
import { applyProofHeaders } from './proof_headers.ts'
import { logRecoveryDiagnostic, buildPublicAccountBody } from './response_helpers.ts'
import type { ManagedHandler, ManagedRoutesOptions } from './managed_types.ts'
import type { ManagedEndpointName, ManagedRoute } from './routes.ts'
import { InvalidArgumentsException } from '@adonisjs/core/exceptions'

function applyRouteResponseHeaders(context: HttpContext, route: ManagedRoute): void {
  if (!route.proof) return
  applyProofHeaders(context.response)
}

interface ManagedRequestExecution<Credential> {
  route: ManagedRoute
  context: HttpContext
  options: ManagedRoutesOptions<Credential>
  methodsEnabled: boolean
  handlers: Record<ManagedEndpointName, ManagedHandler>
}

/** Run the shared managed request checks before dispatching exactly one registered handler. */
export async function executeManagedRequest<Credential>({
  route,
  context,
  options,
  methodsEnabled,
  handlers,
}: ManagedRequestExecution<Credential>): Promise<unknown> {
  applyRouteResponseHeaders(context, route)
  const { request } = context
  const csrfToken = (request as typeof request & { csrfToken?: string }).csrfToken
  if (
    options.guard.strategy === 'session' &&
    (route.method !== 'GET' || route.name === 'auth.csrf') &&
    typeof csrfToken !== 'string'
  )
    throw new InvalidArgumentsException('Managed session routes require Shield CSRF middleware')
  const kit = await options.kit()
  kit.managedHttp.assertGuard(options.guard)
  if (route.proof) await kit.managedHttp.consume({ endpoint: route.name, clientKey: request.ip() })
  const accountInput = route.access === 'public' ? undefined : await options.guard.current(context)
  let account: CurrentAccount | undefined
  try {
    account = accountInput
      ? route.access === 'active' && options.verificationRequired !== false
        ? await kit.authentication.requireActive(accountInput)
        : await kit.authentication.current(accountInput)
      : undefined
  } catch (error) {
    // A stale session can still sign out: end it here instead of refusing the logout.
    if (
      route.name !== 'account.credential.revoke' ||
      options.guard.strategy !== 'session' ||
      !(error instanceof E_ACCOUNT_KIT_INVALID_SESSION)
    )
      throw error
    await options.guard.forRequest(context).terminate()
    return context.response.noContent()
  }
  const actorId = account?.id
  const represent = (value: CurrentAccount) =>
    options.extensions?.representAccount?.(value, context) ?? buildPublicAccountBody(value)
  const representIssued = async (value: CurrentAccount) => {
    try {
      return await represent(value)
    } catch {
      logRecoveryDiagnostic(context, route.name, 'representation_failed')
      return buildPublicAccountBody(value)
    }
  }
  return handlers[route.name]({
    route,
    context,
    options,
    kit,
    csrfToken,
    accountInput,
    account,
    actorId,
    methodsEnabled,
    represent,
    representIssued,
  })
}
