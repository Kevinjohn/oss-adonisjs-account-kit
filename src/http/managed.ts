import type { HttpContext, Router } from '@adonisjs/core/http'
import type {} from '@adonisjs/core/providers/vinejs_provider'
import { applyMappedHeaders, mapManagedErrorResponse } from './responses.ts'
import { managedSocialHandlers } from './social.ts'
import { reportCommittedFailure, getRequestTranslator } from './response_helpers.ts'
import { authenticationHandlers } from './handlers_authentication.ts'
import { emailPasswordManagementHandlers } from './handlers_email_password_management.ts'
import { emailVerificationHandlers } from './handlers_email_verification.ts'
import { accountDataHandlers } from './handlers_account_data.ts'
import { invitationHandlers } from './handlers_invitations.ts'
import { magicLinkHandlers } from './handlers_magic_link.ts'
import { passwordResetHandlers } from './handlers_password_reset.ts'
import { registrationHandlers } from './handlers_registration.ts'
import { sessionManagementHandlers } from './handlers_session_management.ts'
import { managedRouteRegistration, recordManagedRegistration } from './route_registration.ts'
import {
  assertManagedRouteCollisions,
  planManagedRoutes,
  type ManagedEndpointName,
  type ManagedRoute,
} from './routes.ts'
import { assertManagedRoutesOptions } from './managed_options.ts'
import type { ManagedHandler, ManagedRoutesOptions } from './managed_types.ts'
import { executeManagedRequest } from './managed_execution.ts'

export type {
  ManagedExtensions,
  ManagedGuard,
  ManagedHandler,
  ManagedRequest,
  ManagedRoutesOptions,
} from './managed_types.ts'
import { InvalidArgumentsException } from '@adonisjs/core/exceptions'

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

/**
 * Explicitly register one selected managed route group. Never called by the package root.
 *
 * @example
 * ```ts
 * import { registerManagedRoutes } from '@kevinjohn/adonisjs-account-kit/http'
 * import router from '@adonisjs/core/services/router'
 * import app from '@adonisjs/core/services/app'
 * import { AccountKit } from '@kevinjohn/adonisjs-account-kit'
 *
 * registerManagedRoutes(router, {
 *   prefix: '/account',
 *   enabled: ['passwordReset'],
 *   kit: () => app.container.make(AccountKit),
 *   guard,
 * })
 * ```
 */
export function registerManagedRoutes<Credential>(
  router: Router,
  options: ManagedRoutesOptions<Credential>
): readonly ManagedRoute[] {
  return new ManagedRouteRegistration(router, options)
}

class ManagedRouteRegistration<Credential> extends Array<ManagedRoute> {
  #options: ManagedRoutesOptions<Credential>
  #methodsEnabled: boolean

  // Array methods such as map and slice return ordinary arrays of their results.
  static get [Symbol.species]() {
    return Array
  }

  constructor(router: Router, options: ManagedRoutesOptions<Credential>) {
    if (router.commited)
      throw new InvalidArgumentsException(
        'Managed routes must be registered before the router commits'
      )
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
    super(...routes)

    this.#options = options
    this.#methodsEnabled = this.some(({ name }) => name === 'auth.methods')
    for (const route of this) {
      router
        .route(route.path, [route.method], (context) => this.#dispatch(route, context))
        .as(`accountKit.${route.name}`)
    }
    // AdonisJS exposes queued route definitions through toJSON only after commit. The
    // lifecycle wrapper rejects ambiguous application routes before the server starts.
    const commit = router.commit
    const registeredRoutes = this
    router.commit = function (this: Router, ...args: Parameters<Router['commit']>) {
      const result = commit.apply(this, args)
      const committed = routeEntries(this)
      assertManagedRouteCollisions(registeredRoutes, committed)
      return result
    }
    recordManagedRegistration(router, {
      routes: this,
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
  }

  /** @throws {AggregateError} If work and its transaction or credential cleanup both fail, or multiple cleanup steps fail. */
  async #dispatch(route: ManagedRoute, context: HttpContext) {
    try {
      return await executeManagedRequest({
        route,
        context,
        options: this.#options,
        methodsEnabled: this.#methodsEnabled,
        handlers: managedHandlers,
      })
    } catch (error) {
      if (
        (route.method !== 'GET' || route.name === 'auth.oauth.callback') &&
        reportCommittedFailure(context, route.name, error)
      )
        return context.response.accepted({ committed: true })
      const mapped = mapManagedErrorResponse(error, {
        request: context.request,
        message: this.#options.extensions?.message,
        i18n: getRequestTranslator(context),
        proof: route.proofKind,
      })
      if (!mapped) throw error
      // The client gets the masked envelope, so the operator's only record is this log entry.
      // Committed failures were reported above; the error carries no request body or token.
      if (mapped.status >= 500)
        context.logger?.error(
          { err: error, operation: route.name },
          'Managed account operation failed'
        )
      applyMappedHeaders(context, mapped)
      return context.response.status(mapped.status).send(mapped.body)
    }
  }
}
