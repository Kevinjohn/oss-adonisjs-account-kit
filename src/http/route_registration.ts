/** The managed routes an application mounted, recorded per router for documentation and duplicate checks. */
import type { Router } from '@adonisjs/core/http'
import { mountManagedRoutes } from './managed.ts'
import type { ManagedRoutesOptions } from './managed_types.ts'
import type { ManagedRouteRegistration } from './openapi_types.ts'
import type { ManagedRoute } from './routes.ts'

export type {
  JsonSchema,
  ManagedOpenApiOptions,
  ManagedRouteRegistration,
  ReplaceableRequestEndpoint,
} from './openapi_types.ts'

/**
 * Mounts the managed routes and records what each router received. The provider binds one
 * instance as `account_kit.managed_routes`; resolve it from the container.
 */
export class ManagedRoutes {
  readonly #registrations = new WeakMap<Router, ManagedRouteRegistration>()

  /**
   * Explicitly register one selected managed route group. Never called by the package root.
   *
   * @example
   * ```ts
   * managedRoutes.register(router, {
   *   prefix: '/account',
   *   enabled: ['passwordReset'],
   *   kit: () => app.container.make(AccountKit),
   *   guard,
   * })
   * ```
   */
  register<Credential>(
    router: Router,
    options: ManagedRoutesOptions<Credential>
  ): readonly ManagedRoute[] {
    const { routes, registration } = mountManagedRoutes(
      router,
      options,
      this.#registrations.has(router)
    )
    this.#registrations.set(router, registration)
    return routes
  }

  /**
   * The managed routes registered on this router, or `undefined` when none were registered.
   *
   * @example
   * ```ts
   * const registration = managedRoutes.registration(router)
   * ```
   */
  registration(router: Router): ManagedRouteRegistration | undefined {
    return this.#registrations.get(router)
  }
}
