/** What `registerManagedRoutes` mounted on a router, recorded for documentation and duplicate checks. */
import type { Router } from '@adonisjs/core/http'
import type { SocialProviderName } from '../types.js'
import type { ManagedRoute } from './routes.js'

/** A JSON Schema (draft 2020-12, as used by OpenAPI 3.1). */
export type JsonSchema = { [key: string]: unknown }

/** Endpoints whose request body an application can replace through `ManagedExtensions`. */
export type ReplaceableRequestEndpoint =
  'auth.signup' | 'auth.invitation.accept' | 'account.profile.update'

/** Schemas for application-owned parts of the managed API. */
export interface ManagedOpenApiOptions {
  /** Schema of the object `representAccount` returns. Required when `representAccount` is set. */
  accountSchema?: JsonSchema
  /** Request bodies for endpoints whose validator the application replaced. */
  requestBodies?: Partial<Record<ReplaceableRequestEndpoint, JsonSchema>>
}

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
