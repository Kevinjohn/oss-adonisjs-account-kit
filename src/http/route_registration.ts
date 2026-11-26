/** What `registerManagedRoutes` mounted on a router, recorded for documentation and duplicate checks. */
import type { Router } from '@adonisjs/core/http'
import type { ManagedRouteRegistration } from './openapi_types.ts'

export type {
  JsonSchema,
  ManagedOpenApiOptions,
  ManagedRouteRegistration,
  ReplaceableRequestEndpoint,
} from './openapi_types.ts'

const registrations = new WeakMap<Router, ManagedRouteRegistration>()

export function recordManagedRegistration(
  router: Router,
  registration: ManagedRouteRegistration
): void {
  registrations.set(router, registration)
}

/**
 * The managed routes registered on this router, or `undefined` when none were registered.
 *
 * @example
 * ```ts
 * import { managedRouteRegistration } from '@kevinjohn/adonisjs-account-kit/http'
 * import router from '@adonisjs/core/services/router'
 *
 * const registration = managedRouteRegistration(router)
 * ```
 */
export function managedRouteRegistration(router: Router): ManagedRouteRegistration | undefined {
  return registrations.get(router)
}
