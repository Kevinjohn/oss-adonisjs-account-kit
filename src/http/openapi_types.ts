import type { SocialProviderName } from '../types_social.ts'
import type { ManagedCapability, ManagedRoute } from './route_types.ts'

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

export interface ManagedOpenApiInput extends ManagedOpenApiOptions {
  /** From `managedRouteRegistration(router)` after the routes are registered. */
  registration: ManagedRouteRegistration
  info: { title: string; version: string; description?: string }
  /** Session cookie name for session guards. Defaults to `adonis-session`. */
  sessionCookieName?: string
}

/** An OpenAPI 3.1 document for the mounted managed routes. */
export type OpenApiDocument = JsonSchema & {
  openapi: string
  info: ManagedOpenApiInput['info']
  tags: Array<{ name: ManagedCapability; description: string }>
  paths: Record<string, Record<string, JsonSchema>>
  components: JsonSchema & { schemas: Record<string, JsonSchema> }
}
