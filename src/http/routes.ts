export type ManagedCapability =
  | 'authentication'
  | 'registration'
  | 'passwordReset'
  | 'emailVerification'
  | 'emailPasswordManagement'
  | 'invitations'

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

export interface ManagedRoute {
  name: ManagedEndpointName
  capability: ManagedCapability
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  path: string
  access: 'public' | 'limited' | 'active'
  proof?: true
  strategy?: 'session'
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
]

function overlappingPaths(first: string, second: string): boolean {
  const segments = (path: string) => path.replace(/\/+$/, '').split('/').filter(Boolean)
  const left = segments(first)
  const right = segments(second)
  const optional = (part: string) => /^:[A-Za-z_][\w]*\?$/.test(part)
  const wildcard = (part: string) => part === '*'
  const parameter = (part: string) => /^:[A-Za-z_][\w]*\??$/.test(part)
  const visited = new Set<string>()

  function intersects(i: number, j: number): boolean {
    const key = `${i}:${j}`
    if (visited.has(key)) return false
    visited.add(key)
    if (i === left.length && j === right.length) return true
    if (i < left.length && optional(left[i]) && intersects(i + 1, j)) return true
    if (j < right.length && optional(right[j]) && intersects(i, j + 1)) return true
    if (i < left.length && wildcard(left[i])) {
      if (intersects(i + 1, j)) return true
      if (j < right.length && intersects(i, j + 1)) return true
    }
    if (j < right.length && wildcard(right[j])) {
      if (intersects(i, j + 1)) return true
      if (i < left.length && intersects(i + 1, j)) return true
    }
    if (i === left.length || j === right.length) return false
    return (
      (left[i] === right[j] || parameter(left[i]) || parameter(right[j])) &&
      intersects(i + 1, j + 1)
    )
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
        candidate.method.toUpperCase() === route.method &&
        overlappingPaths(candidate.path, route.path)
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
        overlappingPaths(candidate.path, route.path)
    )
    if (collision)
      throw new Error(
        `Managed route collision: ${route.method} ${route.path} overlaps ${collision.name ?? 'an application route'}`
      )
  }
}
