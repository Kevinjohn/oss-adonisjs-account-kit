import type { HttpContext } from '@adonisjs/core/http'
import type { AccountKit } from '../account_kit.js'
import type { AuthenticationGuard, CurrentAccount, CurrentAccountInput } from '../types.js'
import type { ManagedMessage } from './responses.js'
import type { ManagedSocialExtension } from './social.js'
import type { ManagedOpenApiOptions } from './route_registration.js'
import type { ManagedCapability, ManagedEndpointName, ManagedRoute } from './routes.js'

/** Connects the managed routes to your existing guard. `createManagedGuard` builds one. */
export interface ManagedGuard<Credential> {
  /** Must match `authentication.strategy` in the config. */
  strategy: 'session' | 'access_tokens'
  /** Must match `authentication.guard` in the config. */
  name: string
  /** Construct the existing selected guard's service adapter for this request. */
  forRequest(context: HttpContext): AuthenticationGuard<Credential>
  /** Authenticate through that guard and return its trusted token id or session revision. */
  current(context: HttpContext): Promise<CurrentAccountInput>
  /** Return the current credential for bearer logout; sessions may omit this callback. */
  logoutCredential?(context: HttpContext): Promise<Credential>
  /** Expose only the opaque bearer value after successful token issuance. */
  publicCredential?(credential: Credential): string
}

/**
 * Optional overrides for the managed routes: wording, social sign-in, replacement validators and
 * the account representation.
 */
export interface ManagedExtensions {
  /** Public wording only; the stable status and machine code cannot be changed. */
  message?: ManagedMessage
  /** Social sign-in routes. Required when `socialAuthentication` is mounted. */
  social?: ManagedSocialExtension
  /** Replaces the signup body validator. */
  registration?: {
    /** HTTP schema; field mapping and domain rules remain in the public registration service. */
    validate(context: HttpContext): Promise<{
      email: string
      password: string
      registrationData?: unknown
    }>
  }
  /** Replaces the invitation acceptance body validator. */
  invitationAcceptance?: {
    /** HTTP schema for the acceptance body; the token comes from the path. */
    validate(context: HttpContext): Promise<{ password: string; registrationData?: unknown }>
  }
  /** Replaces the profile update body validator. */
  profile?: {
    /** HTTP schema for the profile update body. */
    validate(context: HttpContext): Promise<{
      currentPassword?: string
      recentProof?: string
      email?: string
      registrationData?: unknown
    }>
  }
  /** After service reads; output is application-owned public data and must exclude secrets. */
  representAccount?(
    account: CurrentAccount,
    context: HttpContext
  ): Promise<Record<string, unknown>> | Record<string, unknown>
}

/** Options for `registerManagedRoutes`. */
export interface ManagedRoutesOptions<Credential> {
  /** A static absolute prefix such as `/api`. */
  prefix: string
  /** Resolves the Account Kit service, normally `() => app.container.make(AccountKit)`. */
  kit(): Promise<AccountKit>
  /**
   * Your existing guard, adapted with `createManagedGuard`. Must match `authentication` in the
   * config.
   */
  guard: ManagedGuard<Credential>
  /** The route groups to mount. Each also needs its capability in the config. */
  enabled: readonly ManagedCapability[]
  /** Endpoint names to leave out, for example to replace one with your own route. */
  except?: readonly ManagedEndpointName[]
  /** Require verified email on active routes; defaults to true. Guard and revision checks always apply. */
  verificationRequired?: boolean
  /** Optional overrides; see `ManagedExtensions`. */
  extensions?: ManagedExtensions
  /** Schemas for application-owned bodies, used by `generateManagedOpenApi`. */
  openapi?: ManagedOpenApiOptions
}

/** Everything a managed handler may read once the shared request preamble has run. */
export interface ManagedRequest<Credential> {
  route: ManagedRoute
  context: HttpContext
  options: ManagedRoutesOptions<Credential>
  kit: AccountKit
  csrfToken: string | undefined
  /** The guard's trusted input for the signed-in caller; undefined on public routes. */
  accountInput: CurrentAccountInput | undefined
  account: CurrentAccount | undefined
  actorId: CurrentAccount['id'] | undefined
  methodsEnabled: boolean
  represent(value: CurrentAccount): Promise<Record<string, unknown>> | Record<string, unknown>
  representIssued(value: CurrentAccount): Promise<Record<string, unknown>>
}

export type ManagedHandler = <Credential>(request: ManagedRequest<Credential>) => Promise<unknown>
