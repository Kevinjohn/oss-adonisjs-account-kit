/** What `registerManagedRoutes` mounted on a router, recorded for documentation and duplicate checks. */
import type { Router } from '@adonisjs/core/http'
import type { SocialProviderName } from '../types.js'
import type { ManagedOpenApiOptions } from './openapi_types.js'
import type { ManagedRoute } from './routes.js'

export type {
  JsonSchema,
  ManagedOpenApiOptions,
  ReplaceableRequestEndpoint,
} from './openapi_types.js'

/**
 * What `registerManagedRoutes` mounted on a router. Read it with `managedRouteRegistration` to
 * build the OpenAPI document.
 */
export interface ManagedRouteRegistration {
  routes: readonly ManagedRoute[]
  strategy: 'session' | 'access_tokens'
  prefix: string
  socialProviders: readonly SocialProviderName[]
  /** Which application extensions replace a default schema. */
  replaced: {
    registration: boolean
    invitationAcceptance: boolean
    profile: boolean
    representAccount: boolean
  }
  openapi?: ManagedOpenApiOptions
}

const registrations = new WeakMap<Router, ManagedRouteRegistration>()

export function recordManagedRegistration(
  router: Router,
  registration: ManagedRouteRegistration
): void {
  registrations.set(router, registration)
}

/** The managed routes registered on this router, or `undefined` when none were registered. */
export function managedRouteRegistration(router: Router): ManagedRouteRegistration | undefined {
  return registrations.get(router)
}
