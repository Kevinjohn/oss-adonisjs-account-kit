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
