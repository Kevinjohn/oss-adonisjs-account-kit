import type { ManagedRoute } from './routes.js'

/** A route already registered by the application, checked for collisions with managed routes. */
export interface ExistingRoute {
  /** The HTTP method. */
  method: string
  /** The route pattern, such as `/users/:id`. */
  path: string
  /** The route name, if any. */
  name?: string
  /** Parsed by Adonis when available; retains inherited parameter constraints. */
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

export function overlappingPaths(existing: ExistingRoute, managedPath: string): boolean {
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

/** The error message for a managed route that overlaps an application route. */
export function collisionMessage(route: ManagedRoute, collision: ExistingRoute): string {
  return `Managed route collision: ${route.method} ${route.path} overlaps ${collision.name ?? 'an application route'}`
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
    if (collision) throw new Error(collisionMessage(route, collision))
  }
}
