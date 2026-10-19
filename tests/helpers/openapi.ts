import { readFileSync } from 'node:fs'
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import type { AccountKit } from '../../src/account_kit.js'
import { generateManagedOpenApi, type OpenApiDocument } from '../../src/http/openapi.js'
import { registerManagedRoutes, type ManagedRoutesOptions } from '../../src/http/managed.js'
import { managedRouteRegistration } from '../../src/http/route_registration.js'
import type { ManagedCapability } from '../../src/http/routes.js'
import { fakeManagedHttp } from './managed_http_fakes.js'

/**
 * The official OpenAPI 3.1 schema (https://spec.openapis.org/oas/3.1/schema/2022-10-07). Ajv
 * resolves `$dynamicRef` only against root anchors, so the one dynamic reference is pointed at the
 * schema it names when nothing extends it. Embedded schemas are compiled separately below.
 */
const oasSchema = JSON.parse(
  readFileSync(
    new URL('../fixtures/openapi/oas_3_1_schema.json', import.meta.url),
    'utf8'
  ).replaceAll('"$dynamicRef": "#meta"', '"$ref": "#/$defs/schema"')
)

export const allCapabilities: ManagedCapability[] = [
  'authentication',
  'registration',
  'passwordReset',
  'emailVerification',
  'emailPasswordManagement',
  'invitations',
  'socialAuthentication',
  'magicLinkLogin',
  'sessionManagement',
  'dataExport',
  'accountDeletion',
]

function ajv() {
  const instance = new Ajv2020({ strict: false, allErrors: true })
  addFormats.default(instance)
  instance.addFormat('media-range', true)
  return instance
}

/** Registers managed routes on a fixture router and returns the recorded registration. */
export function registered(
  strategy: 'session' | 'access_tokens',
  options: Partial<ManagedRoutesOptions<unknown>> = {}
) {
  const { router } = fakeManagedHttp()
  registerManagedRoutes(router, {
    prefix: '/api/v1',
    kit: async () => ({}) as AccountKit,
    guard: {
      strategy,
      name: strategy === 'session' ? 'web' : 'api',
      forRequest: () => ({}) as never,
      current: async () => ({ userId: 1 }),
      publicCredential: () => 'opaque',
    },
    enabled: allCapabilities,
    ...options,
    extensions: { social: { providers: ['google', 'github'] }, ...options.extensions },
  })
  return managedRouteRegistration(router)!
}

export function documentFor(
  strategy: 'session' | 'access_tokens',
  options: Partial<ManagedRoutesOptions<unknown>> = {}
): OpenApiDocument {
  return generateManagedOpenApi({
    registration: registered(strategy, options),
    info: { title: 'Test API', version: '1.0.0' },
  })
}

/** Errors from validating the document against the official OpenAPI 3.1 schema. */
export function documentErrors(document: unknown) {
  const validate = ajv().compile(oasSchema)
  return validate(document) ? [] : validate.errors
}

/** Compile one embedded schema with the document's components available by `$ref`. */
export function compileEmbedded(document: OpenApiDocument, schema: unknown): ValidateFunction {
  const instance = ajv()
  instance.addSchema({ $id: 'oas', components: document.components })
  const rewritten = JSON.parse(
    JSON.stringify(schema).replaceAll('"#/components/', '"oas#/components/')
  )
  return instance.compile(rewritten)
}

function operation(document: OpenApiDocument, operationId: string) {
  for (const methods of Object.values(document.paths))
    for (const candidate of Object.values(methods))
      if (candidate.operationId === operationId) return candidate as Record<string, any>
  throw new Error(`No operation ${operationId}`)
}

/** The schema an operation declares for one response status and media type. */
export function responseSchema(
  document: OpenApiDocument,
  operationId: string,
  status: number,
  mediaType = 'application/json'
): unknown {
  const response = operation(document, operationId).responses[status]
  if (!response) throw new Error(`${operationId} does not document ${status}`)
  return response.content?.[mediaType]?.schema
}

export function requestSchema(document: OpenApiDocument, operationId: string): unknown {
  return operation(document, operationId).requestBody?.content['application/json'].schema
}

/**
 * Validate a handler output (`{ status, body }`) against the documented response. The body goes
 * through a JSON round trip first, so Luxon dates are checked as the strings clients receive.
 */
export function conformance(
  document: OpenApiDocument,
  operationId: string,
  output: unknown,
  mediaType = 'application/json'
): string[] {
  const { status, body } = output as { status: number; body?: unknown }
  const schema = responseSchema(document, operationId, status, mediaType)
  if (body === undefined) return schema === undefined ? [] : ['body expected']
  if (schema === undefined) return ['no body documented']
  const validate = compileEmbedded(document, schema)
  return validate(JSON.parse(JSON.stringify(body)))
    ? []
    : (validate.errors ?? []).map((error) => `${error.instancePath} ${error.message}`)
}
