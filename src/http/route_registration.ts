/** What `registerManagedRoutes` mounted on a router, recorded for documentation and duplicate checks. */
import type { Router } from '@adonisjs/core/http'
import type { ManagedRouteRegistration } from './openapi_types.ts'

export type {
  JsonSchema,
  ManagedOpenApiOptions,
  ManagedRouteRegistration,
  ReplaceableRequestEndpoint,
} from './openapi_types.ts'

const registrationKey = Symbol('account_kit.managed_route_registration')

type RegisteredRouter = Router & { [registrationKey]?: ManagedRouteRegistration }

export function recordManagedRegistration(
  router: Router,
  registration: ManagedRouteRegistration
): void {
  Object.defineProperty(router, registrationKey, { value: registration, configurable: true })
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
  return (router as RegisteredRouter)[registrationKey]
}
