/** Builds an OpenAPI 3.1 document for exactly the managed routes registered on one router. */
import { managedEndpointSchemas, ref, sharedSchemas } from './openapi_schemas.js'
import type {
  JsonSchema,
  ManagedOpenApiOptions,
  ReplaceableRequestEndpoint,
} from './openapi_types.js'
import type { ManagedRouteRegistration } from './route_registration.js'
import type { ManagedCapability, ManagedEndpointName, ManagedRoute } from './routes.js'

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

const tagDescriptions: Record<ManagedCapability, string> = {
  authentication: 'Sign-in, sign-out and the current account.',
  registration: 'Public registration.',
  passwordReset: 'Password reset by email link.',
  emailVerification: 'Email verification links.',
  emailPasswordManagement: 'Profile, email change and password change.',
  invitations: 'Invitations sent by signed-in users.',
  socialAuthentication: 'Social sign-in, linking and identities.',
  magicLinkLogin: 'Sign-in by a one-use email link.',
  sessionManagement: 'Signed-in devices: list and revoke sign-ins.',
  dataExport: 'Account data export.',
  accountDeletion: 'Permanent account deletion.',
}

const replaceable: Record<ReplaceableRequestEndpoint, keyof ManagedRouteRegistration['replaced']> =
  {
    'auth.signup': 'registration',
    'auth.invitation.accept': 'invitationAcceptance',
    'account.profile.update': 'profile',
  }

/** Operations that authenticate the caller for `link` and `reauth` intents. */
const optionallyAuthenticated = new Set<ManagedEndpointName>([
  'auth.oauth.redirect',
  'auth.oauth.callback',
  'auth.oauth.complete',
])

const proofHeaders = {
  'Cache-Control': { $ref: '#/components/headers/NoStore' },
  'Referrer-Policy': { $ref: '#/components/headers/NoReferrer' },
}

function openApiPath(path: string): string {
  return path.replace(/:([A-Za-z_]\w*)/g, '{$1}')
}

function pathParameters(route: ManagedRoute, providers: readonly string[]): JsonSchema[] {
  return [...route.path.matchAll(/:([A-Za-z_]\w*)/g)].map(([, name]) => ({
    name,
    in: 'path',
    required: true,
    schema:
      name === 'provider'
        ? ref('SocialProvider')
        : name === 'id'
          ? { type: 'string', pattern: '^[1-9][0-9]*$' }
          : { type: 'string', minLength: 1 },
    description:
      name === 'token'
        ? 'Link token from the email. Treat as a secret.'
        : name === 'id'
          ? 'Positive integer identifier.'
          : `One of: ${providers.join(', ')}.`,
  }))
}

function security(route: ManagedRoute, strategy: ManagedRouteRegistration['strategy']) {
  if (strategy === 'session') {
    if (route.method !== 'GET') return [{ sessionCookie: [], csrfToken: [] }]
    return route.access === 'public' && route.name !== 'auth.oauth.callback'
      ? []
      : [{ sessionCookie: [] }]
  }
  if (route.access !== 'public') return [{ bearerToken: [] }]
  return optionallyAuthenticated.has(route.name) && route.name !== 'auth.oauth.callback'
    ? [{}, { bearerToken: [] }]
    : []
}

function errorResponse(description: string, json: JsonSchema, headers: JsonSchema): JsonSchema {
  return {
    description,
    headers: { Vary: { $ref: '#/components/headers/VaryAccept' }, ...headers },
    content: {
      'application/json': { schema: json },
      'application/vnd.api+json': { schema: ref('JsonApiErrorBody') },
    },
  }
}

function errorResponses(route: ManagedRoute, hasInput: boolean, conflict: boolean) {
  const headers = route.proof ? proofHeaders : {}
  const error = (description: string, json: JsonSchema = ref('ManagedErrorBody')) =>
    errorResponse(description, json, headers)
  const authenticates =
    route.access !== 'public' ||
    route.name === 'auth.login' ||
    optionallyAuthenticated.has(route.name)
  const responses: Record<string, JsonSchema> = {}
  if (route.proof)
    responses[400] = error('The link, proof or social flow state is invalid or expired.')
  if (authenticates) responses[401] = error('Authentication failed.')
  if (authenticates || route.name === 'auth.signup')
    responses[403] = error('Forbidden, or email verification is required.')
  if (route.path.includes(':id') || (route.proof && route.capability === 'socialAuthentication'))
    responses[404] = error('Not found.')
  if (conflict) responses[409] = error('The request conflicts with existing account state.')
  if (hasInput)
    responses[422] = error('The request was rejected.', {
      oneOf: [ref('ManagedErrorBody'), ref('ValidationErrorBody')],
    })
  responses[429] = errorResponse('Too many requests.', ref('ManagedErrorBody'), {
    ...headers,
    'Retry-After': { $ref: '#/components/headers/RetryAfter' },
  })
  responses[500] = error('The operation failed.')
  return responses
}

function successResponses(
  route: ManagedRoute,
  strategy: ManagedRouteRegistration['strategy']
): Record<string, JsonSchema> {
  const declared = managedEndpointSchemas[route.name].success(strategy)
  const headers = route.proof
    ? proofHeaders
    : route.name === 'auth.csrf'
      ? { 'Cache-Control': proofHeaders['Cache-Control'] }
      : undefined
  const responses: Record<string, JsonSchema> = {}
  const committed = route.method !== 'GET' || route.name === 'auth.oauth.callback'
  for (const [status, response] of Object.entries(declared)) {
    const schema =
      committed && status === '202' && response.schema
        ? { oneOf: [response.schema, ref('ManagedCommittedSuccess')] }
        : response.schema
    responses[status] = {
      description: response.description,
      ...(headers ? { headers } : {}),
      ...(schema ? { content: { 'application/json': { schema } } } : {}),
    }
  }
  if (committed && !('202' in responses))
    responses[202] = {
      description:
        'The change committed, but a follow-up (notification or hook) failed. Do not retry.',
      ...(headers ? { headers } : {}),
      content: { 'application/json': { schema: ref('ManagedCommittedSuccess') } },
    }
  return responses
}

function requestBody(
  route: ManagedRoute,
  input: ManagedOpenApiInput,
  requestBodies: ManagedOpenApiOptions['requestBodies']
): JsonSchema | undefined {
  const name = route.name as ReplaceableRequestEndpoint
  const override = requestBodies?.[name]
  if (name in replaceable && input.registration.replaced[replaceable[name]] && !override)
    throw new Error(
      `OpenAPI generation needs openapi.requestBodies['${name}'] because the application replaced its validator`
    )
  const schema = override ?? managedEndpointSchemas[route.name].body?.(input.registration.strategy)
  return schema && { required: true, content: { 'application/json': { schema } } }
}

/** Generate the document. Throws when an application extension has no matching schema. */
export function generateManagedOpenApi(input: ManagedOpenApiInput): OpenApiDocument {
  const { registration } = input
  const accountSchema = input.accountSchema ?? registration.openapi?.accountSchema
  const requestBodies = { ...registration.openapi?.requestBodies, ...input.requestBodies }
  const paths: OpenApiDocument['paths'] = {}
  const tags = new Set<ManagedCapability>()

  for (const route of registration.routes) {
    const schemas = managedEndpointSchemas[route.name]
    const body = requestBody(route, input, requestBodies)
    const parameters = [
      ...pathParameters(route, registration.socialProviders),
      ...(schemas.query ?? []).map((parameter) => ({ in: 'query', ...parameter })),
    ]
    tags.add(route.capability)
    const operation: JsonSchema = {
      operationId: route.name,
      tags: [route.capability],
      summary: schemas.summary,
      ...(schemas.description ? { description: schemas.description } : {}),
      security: security(route, registration.strategy),
      ...(parameters.length ? { parameters } : {}),
      ...(body ? { requestBody: body } : {}),
      responses: {
        ...successResponses(route, registration.strategy),
        ...errorResponses(route, Boolean(body || parameters.length), Boolean(schemas.conflict)),
      },
    }
    const path = openApiPath(route.path)
    paths[path] = { ...paths[path], [route.method.toLowerCase()]: operation }
  }

  const usesAccount = JSON.stringify(paths).match(/#\/components\/schemas\/(Issued)?Account"/)
  if (usesAccount && registration.replaced.representAccount && !accountSchema)
    throw new Error(
      'OpenAPI generation needs openapi.accountSchema because the application sets representAccount'
    )

  return {
    openapi: '3.1.0',
    info: input.info,
    jsonSchemaDialect: 'https://json-schema.org/draft/2020-12/schema',
    tags: [...tags].map((name) => ({ name, description: tagDescriptions[name] })),
    paths,
    components: {
      schemas: {
        ...sharedSchemas(),
        Account: accountSchema ?? ref('SafeAccount'),
        IssuedAccount: accountSchema
          ? {
              anyOf: [ref('Account'), ref('SafeAccount')],
              description:
                'The application representation, or the default fields when representation fails after the change committed.',
            }
          : ref('SafeAccount'),
        SocialProvider: registration.socialProviders.length
          ? { enum: [...registration.socialProviders] }
          : { type: 'string' },
      },
      headers: {
        VaryAccept: { schema: { type: 'string' }, description: 'Includes `Accept`.' },
        RetryAfter: {
          schema: { type: 'integer', minimum: 1 },
          description: 'Seconds until the request may be retried.',
        },
        NoStore: { schema: { const: 'no-store' } },
        NoReferrer: { schema: { const: 'no-referrer' } },
      },
      securitySchemes:
        registration.strategy === 'session'
          ? {
              sessionCookie: {
                type: 'apiKey',
                in: 'cookie',
                name: input.sessionCookieName ?? 'adonis-session',
              },
              csrfToken: {
                type: 'apiKey',
                in: 'header',
                name: 'X-CSRF-TOKEN',
                description: 'From `GET auth/csrf`. Required on every unsafe method.',
              },
            }
          : { bearerToken: { type: 'http', scheme: 'bearer' } },
    },
  }
}
