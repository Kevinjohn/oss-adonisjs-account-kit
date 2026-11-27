/** A group of managed routes you can mount with `ManagedRoutes.register`. */
export type ManagedCapability =
  | 'authentication'
  | 'registration'
  | 'passwordReset'
  | 'magicLinkLogin'
  | 'emailVerification'
  | 'emailPasswordManagement'
  | 'invitations'
  | 'socialAuthentication'
  | 'sessionManagement'
  | 'dataExport'
  | 'accountDeletion'

/**
 * The stable name of one managed endpoint, used in `except`, the endpoint reference and the OpenAPI
 * document.
 */
export type ManagedEndpointName =
  | 'auth.signup'
  | 'auth.csrf'
  | 'auth.login'
  | 'auth.passwordReset.request'
  | 'auth.passwordReset.inspect'
  | 'auth.passwordReset.complete'
  | 'auth.magicLink.request'
  | 'auth.magicLink.inspect'
  | 'auth.magicLink.complete'
  | 'auth.emailVerification.inspect'
  | 'auth.emailVerification.complete'
  | 'auth.invitation.inspect'
  | 'auth.invitation.accept'
  | 'auth.emailChange.inspect'
  | 'auth.emailChange.complete'
  | 'account.credential.revoke'
  | 'account.profile.show'
  | 'account.profile.update'
  | 'account.password.change'
  | 'account.emailVerification.send'
  | 'account.invitation.send'
  | 'account.invitation.list'
  | 'account.invitation.resend'
  | 'account.invitation.revoke'
  | 'auth.oauth.redirect'
  | 'auth.oauth.callback'
  | 'auth.oauth.complete'
  | 'auth.oauth.registration'
  | 'auth.oauth.confirmation'
  | 'auth.oauth.token'
  | 'auth.methods'
  | 'account.socialProof.password'
  | 'account.socialIdentities.list'
  | 'account.socialIdentities.unlink'
  | 'account.sessions.list'
  | 'account.sessions.revoke'
  | 'account.sessions.revokeOthers'
  | 'account.sessions.revokeAll'
  | 'account.data.export'
  | 'account.delete'

/** One managed endpoint: its name, capability, method and full path. */
export interface ManagedRoute {
  /** The stable endpoint name. */
  name: ManagedEndpointName
  /** The route group it belongs to. */
  capability: ManagedCapability
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  /** The full path, including the prefix. */
  path: string
  /**
   * `public` needs no sign-in; `limited` accepts an account that has not confirmed its email;
   * `active` needs a confirmed one.
   */
  access: 'public' | 'limited' | 'active'
  /**
   * True when the request or response carries a proof token, so it gets no-store and no-referrer
   * headers.
   */
  proof?: true
  /** The kind of token a proof route checks; it picks the invalid-token error code. */
  proofKind?: 'password' | 'email' | 'invitation' | 'magicLink'
  /** Set when the route exists only for one guard type. */
  strategy?: 'session' | 'access_tokens'
}

/** Which managed routes to plan: prefix, guard strategy, capabilities and exclusions. */
export interface ManagedRouteSelection {
  /** A static absolute prefix such as `/api`. */
  prefix: string
  /** The guard type. */
  strategy: 'session' | 'access_tokens'
  /** The route groups to include. */
  enabled: readonly ManagedCapability[]
  /** Endpoint names to leave out. */
  except?: readonly ManagedEndpointName[]
}

/** A route already registered by the application, checked for collisions with managed routes. */
export interface ExistingRoute {
  /** The HTTP method. */
  method: string
  /** The route pattern, such as `/users/:id`. */
  path: string
  /** The route name, if any. */
  name?: string
  /** Parsed by AdonisJS when available; retains inherited parameter constraints. */
  tokens?: readonly RoutePatternToken[]
  matchers?: Record<string, { match?: RegExp }>
}

/** One segment of a parsed AdonisJS route pattern. */
export interface RoutePatternToken {
  type: 0 | 1 | 2 | 3
  val: string
  end: string
  matcher?: RegExp
}
