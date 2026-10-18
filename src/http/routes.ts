export type ManagedCapability =
  | 'authentication'
  | 'registration'
  | 'passwordReset'
  | 'emailVerification'
  | 'emailPasswordManagement'
  | 'invitations'
  | 'socialAuthentication'
  | 'dataExport'
  | 'accountDeletion'

export type ManagedEndpointName =
  | 'auth.signup'
  | 'auth.csrf'
  | 'auth.login'
  | 'auth.passwordReset.request'
  | 'auth.passwordReset.inspect'
  | 'auth.passwordReset.complete'
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
  | 'account.data.export'
  | 'account.delete'

export interface ManagedRoute {
  name: ManagedEndpointName
  capability: ManagedCapability
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  path: string
  access: 'public' | 'limited' | 'active'
  proof?: true
  strategy?: 'session' | 'access_tokens'
}

export interface ManagedRouteSelection {
  prefix: string
  strategy: 'session' | 'access_tokens'
  enabled: readonly ManagedCapability[]
  except?: readonly ManagedEndpointName[]
}

export interface ExistingRoute {
  method: string
  path: string
  name?: string
  /** Parsed by Adonis when available; retains inherited parameter constraints. */
  tokens?: readonly RoutePatternToken[]
  matchers?: Record<string, { match?: RegExp }>
}

export interface RoutePatternToken {
  type: 0 | 1 | 2 | 3
  val: string
  end: string
  matcher?: RegExp
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

function pathTokens(path: string, matchers: ExistingRoute['matchers'] = {}): RoutePatternToken[] {
  return path
    .replace(/\/+$/, '')
    .split('/')
    .filter(Boolean)
    .map((part) => {
      if (part === '*') return { type: 2, val: part, end: '' }
      if (!part.startsWith(':')) return { type: 0, val: part, end: '' }
      const name = part.slice(1)
      const dot = name.indexOf('.')
      const key = name.slice(0, dot === -1 ? undefined : dot).replace(/\?$/, '')
      return {
        type: part.includes('?') ? 3 : 1,
        val: key,
        end: dot === -1 ? '' : name.slice(dot),
        matcher: matchers?.[key]?.match,
      }
    })
}

function overlapsSegment(left: RoutePatternToken, right: RoutePatternToken): boolean {
  const accepts = (token: RoutePatternToken, value: string) =>
    value.endsWith(token.end) &&
    (!token.matcher ||
      new RegExp(token.matcher.source, token.matcher.flags.replace(/[gy]/g, '')).test(value))
  if (left.type === 0 && right.type === 0) return left.val === right.val
  if (left.type === 0) return accepts(right, left.val)
  if (right.type === 0) return accepts(left, right.val)
  // Managed parameters have no additional matcher; a constrained application
  // parameter may still intersect them when their literal suffixes intersect.
  return left.end.endsWith(right.end) || right.end.endsWith(left.end)
}

function overlappingPaths(existing: ExistingRoute, managedPath: string): boolean {
  const left = existing.tokens ?? pathTokens(existing.path, existing.matchers)
  const right = pathTokens(managedPath)
  const visited = new Set<string>()

  // The tree matcher can traverse missing parameter segments at the end of a
  // request, but only an optional segment restores a terminal route match.
  // A suffix-bearing parameter cannot be traversed without a segment.
  function acceptsMissingTail(tokens: readonly RoutePatternToken[], index: number): boolean {
    let terminalAllowed = true
    for (const token of tokens.slice(index)) {
      if (token.end !== '' || (token.type !== 1 && token.type !== 3)) return false
      terminalAllowed = token.type === 3
    }
    return terminalAllowed
  }

  function intersects(i: number, j: number): boolean {
    const key = `${i}:${j}`
    if (visited.has(key)) return false
    visited.add(key)
    if (i === left.length) return acceptsMissingTail(right, j)
    if (j === right.length) return acceptsMissingTail(left, i)
    if (i < left.length && left[i].type === 2) {
      // A wildcard must consume at least one trailing segment.
      if (j < right.length && (intersects(i + 1, j + 1) || intersects(i, j + 1))) return true
    }
    if (j < right.length && right[j].type === 2) {
      if (i < left.length && (intersects(i + 1, j + 1) || intersects(i + 1, j))) return true
    }
    return overlapsSegment(left[i], right[j]) && intersects(i + 1, j + 1)
  }

  return intersects(0, 0)
}

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
    if (collision)
      throw new Error(
        `Managed route collision: ${route.method} ${route.path} overlaps ${collision.name ?? 'an application route'}`
      )
  }
  return result
}

/** Also run after Adonis commits queued application routes, before it serves requests. */
export function assertManagedRouteCollisions(
  managed: readonly ManagedRoute[],
  existing: readonly ExistingRoute[]
): void {
  for (const route of managed) {
    const collision = existing.find(
      (candidate) =>
        candidate.name !== `accountKit.${route.name}` &&
        candidate.method.toUpperCase() === route.method &&
        overlappingPaths(candidate, route.path)
    )
    if (collision)
      throw new Error(
        `Managed route collision: ${route.method} ${route.path} overlaps ${collision.name ?? 'an application route'}`
      )
  }
}
