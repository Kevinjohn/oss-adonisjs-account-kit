import { collisionMessage, overlappingPaths, type ExistingRoute } from './route_collisions.js'

export {
  assertManagedRouteCollisions,
  type ExistingRoute,
  type RoutePatternToken,
} from './route_collisions.js'

/** A group of managed routes you can mount with `registerManagedRoutes`. */
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
  | 'account.logout'
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

const definitions: readonly (Omit<ManagedRoute, 'path'> & { suffix: string })[] = [
  {
    name: 'auth.signup',
    capability: 'registration',
    method: 'POST',
    suffix: 'auth/signup',
    access: 'public',
  },
  {
    name: 'auth.csrf',
    capability: 'authentication',
    method: 'GET',
    suffix: 'auth/csrf',
    access: 'public',
    strategy: 'session',
  },
  {
    name: 'auth.login',
    capability: 'authentication',
    method: 'POST',
    suffix: 'auth/login',
    access: 'public',
  },
  {
    name: 'auth.passwordReset.request',
    capability: 'passwordReset',
    method: 'POST',
    suffix: 'auth/password-reset',
    access: 'public',
  },
  {
    name: 'auth.passwordReset.inspect',
    capability: 'passwordReset',
    method: 'GET',
    suffix: 'auth/password-reset/:token',
    access: 'public',
    proof: true,
  },
  {
    name: 'auth.passwordReset.complete',
    capability: 'passwordReset',
    method: 'POST',
    suffix: 'auth/password-reset/:token',
    access: 'public',
    proof: true,
  },
  {
    name: 'auth.magicLink.request',
    capability: 'magicLinkLogin',
    method: 'POST',
    suffix: 'auth/magic-link',
    access: 'public',
  },
  {
    name: 'auth.magicLink.inspect',
    capability: 'magicLinkLogin',
    method: 'GET',
    suffix: 'auth/magic-link/:token',
    access: 'public',
    proof: true,
  },
  {
    name: 'auth.magicLink.complete',
    capability: 'magicLinkLogin',
    method: 'POST',
    suffix: 'auth/magic-link/:token',
    access: 'public',
    proof: true,
  },
  {
    name: 'auth.emailVerification.inspect',
    capability: 'emailVerification',
    method: 'GET',
    suffix: 'auth/email-verification/:token',
    access: 'public',
    proof: true,
  },
  {
    name: 'auth.emailVerification.complete',
    capability: 'emailVerification',
    method: 'POST',
    suffix: 'auth/email-verification/:token',
    access: 'public',
    proof: true,
  },
  {
    name: 'auth.invitation.inspect',
    capability: 'invitations',
    method: 'GET',
    suffix: 'auth/invitations/:token',
    access: 'public',
    proof: true,
  },
  {
    name: 'auth.invitation.accept',
    capability: 'invitations',
    method: 'POST',
    suffix: 'auth/invitations/:token',
    access: 'public',
    proof: true,
  },
  {
    name: 'auth.emailChange.inspect',
    capability: 'emailPasswordManagement',
    method: 'GET',
    suffix: 'auth/email-change/:token',
    access: 'public',
    proof: true,
  },
  {
    name: 'auth.emailChange.complete',
    capability: 'emailPasswordManagement',
    method: 'POST',
    suffix: 'auth/email-change/:token',
    access: 'public',
    proof: true,
  },
  {
    name: 'account.logout',
    capability: 'authentication',
    method: 'POST',
    suffix: 'account/logout',
    access: 'limited',
  },
  {
    name: 'account.profile.show',
    capability: 'authentication',
    method: 'GET',
    suffix: 'account/profile',
    access: 'limited',
  },
  {
    name: 'account.profile.update',
    capability: 'emailPasswordManagement',
    method: 'PATCH',
    suffix: 'account/profile',
    access: 'limited',
  },
  {
    name: 'account.password.change',
    capability: 'emailPasswordManagement',
    method: 'POST',
    suffix: 'account/password',
    access: 'active',
  },
  {
    name: 'account.emailVerification.send',
    capability: 'emailVerification',
    method: 'POST',
    suffix: 'account/email-verification/send',
    access: 'limited',
  },
  {
    name: 'account.invitation.send',
    capability: 'invitations',
    method: 'POST',
    suffix: 'account/invitations',
    access: 'active',
  },
  {
    name: 'account.invitation.list',
    capability: 'invitations',
    method: 'GET',
    suffix: 'account/invitations',
    access: 'active',
  },
  {
    name: 'account.invitation.resend',
    capability: 'invitations',
    method: 'POST',
    suffix: 'account/invitations/:id/resend',
    access: 'active',
  },
  {
    name: 'account.invitation.revoke',
    capability: 'invitations',
    method: 'DELETE',
    suffix: 'account/invitations/:id',
    access: 'active',
  },
  {
    name: 'auth.oauth.redirect',
    capability: 'socialAuthentication',
    method: 'POST',
    suffix: 'auth/oauth/:provider/redirect',
    access: 'public',
    proof: true,
  },
  {
    name: 'auth.oauth.callback',
    capability: 'socialAuthentication',
    method: 'GET',
    suffix: 'auth/oauth/:provider/callback',
    access: 'public',
    proof: true,
  },
  {
    name: 'auth.oauth.complete',
    capability: 'socialAuthentication',
    method: 'POST',
    suffix: 'auth/oauth/:provider/callback',
    access: 'public',
    proof: true,
    strategy: 'access_tokens',
  },
  {
    name: 'auth.oauth.registration',
    capability: 'socialAuthentication',
    method: 'POST',
    suffix: 'auth/oauth/registration',
    access: 'public',
    proof: true,
  },
  {
    name: 'auth.oauth.confirmation',
    capability: 'socialAuthentication',
    method: 'POST',
    suffix: 'auth/oauth/:provider/confirmation',
    access: 'public',
    proof: true,
  },
  {
    name: 'auth.oauth.token',
    capability: 'socialAuthentication',
    method: 'POST',
    suffix: 'auth/oauth/token',
    access: 'public',
    proof: true,
    strategy: 'access_tokens',
  },
  {
    name: 'auth.methods',
    capability: 'socialAuthentication',
    method: 'GET',
    suffix: 'auth/methods',
    access: 'public',
  },
  {
    name: 'account.socialProof.password',
    capability: 'socialAuthentication',
    method: 'POST',
    suffix: 'account/social-proof/password',
    access: 'limited',
    proof: true,
  },
  {
    name: 'account.socialIdentities.list',
    capability: 'socialAuthentication',
    method: 'GET',
    suffix: 'account/social-identities',
    access: 'limited',
  },
  {
    name: 'account.socialIdentities.unlink',
    capability: 'socialAuthentication',
    method: 'DELETE',
    suffix: 'account/social-identities/:id',
    access: 'limited',
    proof: true,
  },
  {
    name: 'account.sessions.list',
    capability: 'sessionManagement',
    method: 'GET',
    suffix: 'account/sessions',
    access: 'limited',
  },
  {
    name: 'account.sessions.revoke',
    capability: 'sessionManagement',
    method: 'DELETE',
    suffix: 'account/sessions/:id',
    access: 'limited',
  },
  {
    name: 'account.sessions.revokeOthers',
    capability: 'sessionManagement',
    method: 'POST',
    suffix: 'account/sessions/revoke-others',
    access: 'limited',
  },
  {
    name: 'account.sessions.revokeAll',
    capability: 'sessionManagement',
    method: 'POST',
    suffix: 'account/sessions/revoke-all',
    access: 'limited',
  },
  {
    name: 'account.data.export',
    capability: 'dataExport',
    method: 'POST',
    suffix: 'account/export',
    access: 'limited',
  },
  {
    name: 'account.delete',
    capability: 'accountDeletion',
    method: 'DELETE',
    suffix: 'account',
    access: 'limited',
  },
]

/**
 * Lists the routes `registerManagedRoutes` would mount, and throws if one collides with an existing
 * route.
 */
export function planManagedRoutes(
  selection: ManagedRouteSelection,
  existing: readonly ExistingRoute[] = [],
  alreadyRegistered = false
): ManagedRoute[] {
  const { prefix, strategy, enabled, except = [] } = selection
  if (alreadyRegistered) throw new Error('Account Kit managed routes are already registered')
  if (!/^\/(?:[\w-]+(?:\/[\w-]+)*)?$/.test(prefix) || prefix === '/')
    throw new Error('Managed route prefix must be an absolute static path')
  if (
    new Set(enabled).size !== enabled.length ||
    enabled.some((name) => !definitions.some((route) => route.capability === name))
  )
    throw new Error('Invalid managed capabilities')
  if (
    new Set(except).size !== except.length ||
    except.some((name) => !definitions.some((route) => route.name === name))
  )
    throw new Error('Invalid managed endpoint exclusion')

  const result = definitions
    .filter(
      (route) =>
        (enabled.includes(route.capability) ||
          (route.name === 'auth.csrf' && strategy === 'session' && enabled.length > 0)) &&
        (!route.strategy || route.strategy === strategy) &&
        !except.includes(route.name)
    )
    .map(({ suffix, ...route }) => ({ ...route, path: `${prefix.replace(/\/$/, '')}/${suffix}` }))

  for (const route of result) {
    const collision = existing.find(
      (candidate) =>
        candidate.method.toUpperCase() === route.method && overlappingPaths(candidate, route.path)
    )
    if (collision) throw new Error(collisionMessage(route, collision))
  }
  return result
}
