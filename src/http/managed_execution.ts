import type { HttpContext } from '@adonisjs/core/http'
import type { CurrentAccount } from '../types.js'
import { applyProofHeaders } from './proof_headers.js'
import { recoveryDiagnostic, publicAccount } from './response_helpers.js'
import type { ManagedHandler, ManagedRoutesOptions } from './managed_types.js'
import type { ManagedEndpointName, ManagedRoute } from './routes.js'

function responseHeaders(context: HttpContext, route: ManagedRoute): void {
  if (!route.proof) return
  applyProofHeaders(context.response)
}

/** Run the shared managed request checks before dispatching exactly one registered handler. */
export async function executeManagedRequest<Credential>(
  route: ManagedRoute,
  context: HttpContext,
  options: ManagedRoutesOptions<Credential>,
  methodsEnabled: boolean,
  handlers: Record<ManagedEndpointName, ManagedHandler>
): Promise<unknown> {
  responseHeaders(context, route)
  const { request } = context
  const csrfToken = (request as typeof request & { csrfToken?: string }).csrfToken
  if (
    options.guard.strategy === 'session' &&
    (route.method !== 'GET' || route.name === 'auth.csrf') &&
    typeof csrfToken !== 'string'
  )
    throw new Error('Managed session routes require Shield CSRF middleware')
  const kit = await options.kit()
  kit.managedHttp.assertGuard(options.guard)
  if (route.proof) await kit.managedHttp.consume({ endpoint: route.name, clientKey: request.ip() })
  const accountInput = route.access === 'public' ? undefined : await options.guard.current(context)
  const account = accountInput
    ? route.access === 'active' && options.verificationRequired !== false
      ? await kit.authentication.requireActive(accountInput)
      : await kit.authentication.current(accountInput)
    : undefined
  const actorId = account?.id
  const represent = (value: CurrentAccount) =>
    options.extensions?.representAccount?.(value, context) ?? publicAccount(value)
  const representIssued = async (value: CurrentAccount) => {
    try {
      return await represent(value)
    } catch {
      recoveryDiagnostic(context, route.name, 'representation_failed')
      return publicAccount(value)
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
