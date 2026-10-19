import type { AccountKit } from '../../src/account_kit.js'
import { generateManagedOpenApi, type OpenApiDocument } from '../../src/http/openapi.js'
import { registerManagedRoutes, type ManagedRoutesOptions } from '../../src/http/managed.js'
import { managedRouteRegistration } from '../../src/http/route_registration.js'
import type { ManagedCapability } from '../../src/http/routes.js'
import { fixture } from './managed_http.js'

export {
  compileEmbedded,
  conformance,
  documentErrors,
  requestSchema,
  responseSchema,
} from './openapi_validation.js'

/** Every managed capability; a missing one fails to compile. */
const capabilityFlags: Record<ManagedCapability, true> = {
  authentication: true,
  registration: true,
  passwordReset: true,
  emailVerification: true,
  emailPasswordManagement: true,
  invitations: true,
  socialAuthentication: true,
  magicLinkLogin: true,
  sessionManagement: true,
  dataExport: true,
  accountDeletion: true,
}

export const allCapabilities = Object.keys(capabilityFlags) as ManagedCapability[]

/** Registers managed routes on a fixture router and returns the recorded registration. */
export function registered(
  strategy: 'session' | 'access_tokens',
  options: Partial<ManagedRoutesOptions<unknown>> = {}
) {
  const { router } = fixture()
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
