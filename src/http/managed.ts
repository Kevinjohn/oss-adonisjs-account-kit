import type { HttpContext, Router } from '@adonisjs/core/http'
import type {} from '@adonisjs/core/providers/vinejs_provider'
import type { CurrentAccount } from '../types.js'
import { applyMappedHeaders, managedErrorResponse } from './responses.js'
import { applyProofHeaders } from './proof_headers.js'
import { managedSocialHandlers } from './social.js'
import {
  recoveryDiagnostic,
  reportCommittedFailure,
  requestTranslator,
  publicAccount,
} from './response_helpers.js'
import { authenticationHandlers } from './handlers_authentication.js'
import { emailPasswordManagementHandlers } from './handlers_email_password_management.js'
import { emailVerificationHandlers } from './handlers_email_verification.js'
import { accountDataHandlers } from './handlers_account_data.js'
import { invitationHandlers } from './handlers_invitations.js'
import { magicLinkHandlers } from './handlers_magic_link.js'
import { passwordResetHandlers } from './handlers_password_reset.js'
import { registrationHandlers } from './handlers_registration.js'
import { sessionManagementHandlers } from './handlers_session_management.js'
import { managedRouteRegistration, recordManagedRegistration } from './route_registration.js'
import {
  assertManagedRouteCollisions,
  planManagedRoutes,
  type ManagedEndpointName,
  type ManagedRoute,
} from './routes.js'
import { assertManagedRoutesOptions } from './managed_options.js'
import type { ManagedHandler, ManagedRoutesOptions } from './managed_types.js'

export type {
  ManagedExtensions,
  ManagedGuard,
  ManagedHandler,
  ManagedRequest,
  ManagedRoutesOptions,
} from './managed_types.js'

/** Flatten committed router definitions into one entry per method for collision checks. */
function routeEntries(router: Router) {
  return (router.toJSON().root ?? []).flatMap((route) =>
    route.methods.map((method) => ({
      method,
      path: route.pattern,
      name: route.name,
      tokens: route.tokens,
      matchers: route.matchers,
    }))
  )
}

function responseHeaders(context: HttpContext, route: ManagedRoute): void {
  if (!route.proof) return
  applyProofHeaders(context.response)
}

/** One handler per endpoint: a route added to routes.ts without a handler does not compile. */
export const managedHandlers: Record<ManagedEndpointName, ManagedHandler> = {
  ...authenticationHandlers,
  ...registrationHandlers,
  ...passwordResetHandlers,
  ...magicLinkHandlers,
  ...emailVerificationHandlers,
  ...emailPasswordManagementHandlers,
  ...invitationHandlers,
  ...managedSocialHandlers,
  ...sessionManagementHandlers,
  ...accountDataHandlers,
}

async function execute<Credential>(
  route: ManagedRoute,
  context: HttpContext,
  options: ManagedRoutesOptions<Credential>,
  methodsEnabled: boolean
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
  return managedHandlers[route.name]({
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

/** Explicitly register one selected managed route group. Never called by the package root. */
export function registerManagedRoutes<Credential>(
  router: Router,
  options: ManagedRoutesOptions<Credential>
): readonly ManagedRoute[] {
  if (router.commited)
    throw new Error('Managed routes must be registered before the router commits')
  assertManagedRoutesOptions(options)
  const existing = routeEntries(router)
  const routes = planManagedRoutes(
    {
      prefix: options.prefix,
      strategy: options.guard.strategy,
      enabled: options.enabled,
      except: options.except,
    },
    existing,
    managedRouteRegistration(router) !== undefined
  )
  const methodsEnabled = routes.some(({ name }) => name === 'auth.methods')
  for (const route of routes) {
    router
      .route(route.path, [route.method], async (context) => {
        try {
          return await execute(route, context, options, methodsEnabled)
        } catch (error) {
          if (
            (route.method !== 'GET' || route.name === 'auth.oauth.callback') &&
            reportCommittedFailure(context, route.name, error)
          )
            return context.response.accepted({ committed: true })
          const mapped = managedErrorResponse(error, {
            accept: context.request.header('accept'),
            message: options.extensions?.message,
            i18n: requestTranslator(context),
            proof: route.proofKind,
          })
          if (!mapped) throw error
          applyMappedHeaders(context, mapped)
          return context.response.status(mapped.status).send(mapped.body)
        }
      })
      .as(`accountKit.${route.name}`)
  }
  // Adonis exposes queued route definitions through toJSON only after commit. The
  // lifecycle wrapper rejects ambiguous application routes before the server starts.
  const commit = router.commit
  router.commit = function (this: Router, ...args: Parameters<Router['commit']>) {
    const result = commit.apply(this, args)
    const committed = routeEntries(this)
    assertManagedRouteCollisions(routes, committed)
    return result
  }
  recordManagedRegistration(router, {
    routes,
    strategy: options.guard.strategy,
    prefix: options.prefix,
    socialProviders: options.enabled.includes('socialAuthentication')
      ? (options.extensions?.social?.providers ?? [])
      : [],
    replaced: {
      registration: Boolean(options.extensions?.registration),
      invitationAcceptance: Boolean(options.extensions?.invitationAcceptance),
      profile: Boolean(options.extensions?.profile),
      representAccount: Boolean(options.extensions?.representAccount),
    },
    openapi: options.openapi,
  })
  return routes
}
