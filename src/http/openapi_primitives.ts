import type { JsonSchema } from './openapi_types.js'

type Strategy = 'session' | 'access_tokens'

export const ref = (name: string): JsonSchema => ({ $ref: `#/components/schemas/${name}` })

export const closed = (
  properties: Record<string, JsonSchema>,
  required = Object.keys(properties)
) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
})

export const string = (extra: JsonSchema = {}): JsonSchema => ({ type: 'string', ...extra })
export const constant = (value: unknown): JsonSchema => ({ const: value })
export const email = (): JsonSchema => string({ format: 'email', maxLength: 254 })
export const password = (): JsonSchema => string({ minLength: 8, maxLength: 256 })
export const nonEmpty = (): JsonSchema => string({ minLength: 1 })
export const registrationData = (): JsonSchema => ({
  type: 'object',
  description: 'Application-defined fields, mapped by the application users adapter.',
})

/** Request bodies are open objects: the validators ignore unknown properties. */
export const body = (properties: Record<string, JsonSchema>, required: string[]): JsonSchema => ({
  type: 'object',
  properties,
  required,
})

export const confirmed = (field: string) =>
  string({ description: `Must equal \`${field}\`. Checked by the server, not by this schema.` })

export const policyNote =
  'The new password must also satisfy the configured password policy (422 `passwordPolicy`).'

export const accountBody = (strategy: Strategy, token: 'optional' | 'required' | 'none') =>
  closed(
    {
      account: ref('IssuedAccount'),
      ...(strategy === 'access_tokens' && token !== 'none'
        ? { token: string({ description: 'Opaque bearer access token.' }) }
        : {}),
    },
    strategy === 'access_tokens' && token === 'required' ? ['account', 'token'] : ['account']
  )

export const ok = (description: string, schema?: JsonSchema) => () => ({
  200: { description, schema },
})
export const valid = ok('The link is valid.', closed({ valid: constant(true) }))
export const noContent = () => ({ 204: { description: 'Done. No body.' } })
export const socialFlow = () => ({
  200: { description: 'Social flow result.', schema: ref('SocialFlowResult') },
})
export const authorizationUrl = ok(
  'Provider authorisation URL for the browser to visit.',
  closed({ authorizationUrl: string({ format: 'uri' }) })
)

export const clientChallenge = (strategy: Strategy): JsonSchema =>
  string({
    description:
      strategy === 'access_tokens'
        ? 'Base64url SHA-256 of a client-held verifier (PKCE S256). Required for access tokens.'
        : 'Ignored for session guards; the server holds the verifier.',
  })
