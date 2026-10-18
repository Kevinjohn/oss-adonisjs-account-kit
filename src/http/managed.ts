import type { HttpContext, Router } from '@adonisjs/core/http'
import type {} from '@adonisjs/core/providers/vinejs_provider'
import type { AccountKit } from '../account_kit.js'
import { DeliveryError, PostCommitError } from '../errors.js'
import { isSocialProviderName } from '../social_providers.js'
import type { AuthenticationGuard, CurrentAccount, CurrentAccountInput } from '../types.js'
import { managedErrorResponse, proofHeaders, type ManagedMessage } from './responses.js'
import { managedSocialHandlers, type ManagedSocialExtension } from './social.js'
import { applyMappedHeaders, recoveryDiagnostic, safeAccount } from './response_helpers.js'
import { authenticationHandlers } from './handlers_authentication.js'
import { emailPasswordManagementHandlers } from './handlers_email_password_management.js'
import { emailVerificationHandlers } from './handlers_email_verification.js'
import { invitationHandlers } from './handlers_invitations.js'
import { magicLinkHandlers } from './handlers_magic_link.js'
import { passwordResetHandlers } from './handlers_password_reset.js'
import { registrationHandlers } from './handlers_registration.js'
import {
  assertManagedRouteCollisions,
  planManagedRoutes,
  type ManagedCapability,
  type ManagedEndpointName,
  type ManagedRoute,
} from './routes.js'

export interface ManagedGuard<Credential> {
  strategy: 'session' | 'access_tokens'
  name: string
  /** Construct the existing selected guard's service adapter for this request. */
  forRequest(context: HttpContext): AuthenticationGuard<Credential>
  /** Authenticate through that guard and return its trusted token id or session revision. */
  current(context: HttpContext): Promise<CurrentAccountInput>
  /** Return the current credential for bearer logout; sessions may omit this callback. */
  logoutCredential?(context: HttpContext): Promise<Credential>
  /** Expose only the opaque bearer value after successful token issuance. */
  publicCredential?(credential: Credential): string
}

export interface ManagedExtensions {
  /** Public wording only; the stable status and machine code cannot be changed. */
  message?: ManagedMessage
  social?: ManagedSocialExtension
  registration?: {
    /** HTTP schema; field mapping and domain rules remain in the public registration service. */
    validate(context: HttpContext): Promise<{
      email: string
      password: string
      registrationData?: unknown
    }>
  }
  invitationAcceptance?: {
    validate(context: HttpContext): Promise<{ password: string; registrationData?: unknown }>
  }
  profile?: {
    validate(context: HttpContext): Promise<{
      currentPassword?: string
      recentProof?: string
      email?: string
      registrationData?: unknown
    }>
  }
  /** After service reads; output is application-owned public data and must exclude secrets. */
  representAccount?(
    account: CurrentAccount,
    context: HttpContext
  ): Promise<Record<string, unknown>> | Record<string, unknown>
}

export interface ManagedRoutesOptions<Credential> {
  prefix: string
  kit(): Promise<AccountKit>
  guard: ManagedGuard<Credential>
  enabled: readonly ManagedCapability[]
  except?: readonly ManagedEndpointName[]
  /** Require verified email on active routes; defaults to true. Guard and revision checks always apply. */
  verificationRequired?: boolean
  extensions?: ManagedExtensions
}

const mounted = new WeakSet<Router>()

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
  for (const [name, value] of Object.entries(proofHeaders())) context.response.header(name, value)
}

/** Everything a managed handler may read once the shared request preamble has run. */
export interface ManagedRequest<Credential> {
  route: ManagedRoute
  context: HttpContext
  options: ManagedRoutesOptions<Credential>
  kit: AccountKit
  csrfToken: string | undefined
  account: CurrentAccount | undefined
  actorId: CurrentAccount['id'] | undefined
  methodsEnabled: boolean
  represent(value: CurrentAccount): Promise<Record<string, unknown>> | Record<string, unknown>
  representIssued(value: CurrentAccount): Promise<Record<string, unknown>>
}

export type ManagedHandler = <Credential>(request: ManagedRequest<Credential>) => Promise<unknown>

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
    options.extensions?.representAccount?.(value, context) ?? safeAccount(value)
  const representIssued = async (value: CurrentAccount) => {
    try {
      return await represent(value)
    } catch {
      recoveryDiagnostic(context, route.name, 'representation_failed')
      return safeAccount(value)
    }
  }
  return managedHandlers[route.name]({
    route,
    context,
    options,
    kit,
    csrfToken,
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
  if (
    options.guard.strategy === 'access_tokens' &&
    options.enabled.some(
      (capability) =>
        capability === 'authentication' ||
        capability === 'registration' ||
        capability === 'magicLinkLogin' ||
        capability === 'socialAuthentication'
    ) &&
    !options.guard.publicCredential
  )
    throw new Error('Managed access-token routes require publicCredential')
  if (
    options.enabled.includes('socialAuthentication') &&
    (!options.extensions?.social ||
      !options.extensions.social.providers.length ||
      options.extensions.social.providers.some((name) => !isSocialProviderName(name)) ||
      new Set(options.extensions.social.providers).size !==
        options.extensions.social.providers.length)
  )
    throw new Error('Managed social routes require a selected Google or GitHub provider inventory')
  const existing = routeEntries(router)
  const routes = planManagedRoutes(
    {
      prefix: options.prefix,
      strategy: options.guard.strategy,
      enabled: options.enabled,
      except: options.except,
    },
    existing,
    mounted.has(router)
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
            (error instanceof PostCommitError || error instanceof DeliveryError)
          ) {
            recoveryDiagnostic(
              context,
              route.name,
              error instanceof DeliveryError ? 'delivery_failed' : 'followup_failed'
            )
            return context.response.accepted({ committed: true })
          }
          const mapped = managedErrorResponse(error, {
            accept: context.request.header('accept'),
            message: options.extensions?.message,
            proof:
              route.proof && route.capability !== 'socialAuthentication'
                ? route.name.includes('passwordReset')
                  ? 'password'
                  : route.name.includes('invitation')
                    ? 'invitation'
                    : route.capability === 'magicLinkLogin'
                      ? 'magicLink'
                      : 'email'
                : undefined,
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
  mounted.add(router)
  return routes
}
