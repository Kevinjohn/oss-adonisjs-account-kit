import type { ExistingRoute, ManagedRoute, RoutePatternToken } from './route_types.ts'
import { InvalidArgumentsException } from '@adonisjs/core/exceptions'

export type { ExistingRoute, RoutePatternToken } from './route_types.ts'

function tokenizeRoutePath(
  path: string,
  matchers: ExistingRoute['matchers'] = {}
): RoutePatternToken[] {
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

// Recognize a standalone lookahead without nested groups or character classes. It consumes no
// input, so a sticky matcher in this subset cannot advance from its initial index.
const simpleLookahead = /^\(\?[=!](?:\\.|[^\\()[\]])*\)$/

function matcherAccepts(matcher: RegExp, value: string): boolean {
  // AdonisJS can reuse a matcher across requests. Keep the conservative overlap check when a
  // sticky matcher may start at an index left by an earlier match.
  const mayStartLater =
    matcher.sticky && (matcher.lastIndex !== 0 || !simpleLookahead.test(matcher.source))
  const flags = mayStartLater ? matcher.flags.replace('y', '') : matcher.flags
  return new RegExp(matcher.source, flags).test(value)
}

function overlapsSegment(left: RoutePatternToken, right: RoutePatternToken): boolean {
  const accepts = (token: RoutePatternToken, value: string) =>
    value.endsWith(token.end) && (!token.matcher || matcherAccepts(token.matcher, value))
  if (left.type === 0 && right.type === 0) return left.val === right.val
  if (left.type === 0) return accepts(right, left.val)
  if (right.type === 0) return accepts(left, right.val)
  // Managed parameters have no additional matcher; a constrained application
  // parameter may still intersect them when their literal suffixes intersect.
  return left.end.endsWith(right.end) || right.end.endsWith(left.end)
}

export function doPathsOverlap(existing: ExistingRoute, managedPath: string): boolean {
  const left = existing.tokens ?? tokenizeRoutePath(existing.path, existing.matchers)
  const right = tokenizeRoutePath(managedPath)
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
export function formatCollisionMessage(route: ManagedRoute, collision: ExistingRoute): string {
  return `Managed route collision: ${route.method} ${route.path} overlaps ${collision.name ?? 'an application route'}`
}

/** Also run after AdonisJS commits queued application routes, before it serves requests. */
export function assertManagedRouteCollisions(
  managed: readonly ManagedRoute[],
  existing: readonly ExistingRoute[]
): void {
  for (const route of managed) {
    const collision = existing.find(
      (candidate) =>
        candidate.name !== `accountKit.${route.name}` &&
        candidate.method.toUpperCase() === route.method &&
        doPathsOverlap(candidate, route.path)
    )
    if (collision) throw new InvalidArgumentsException(formatCollisionMessage(route, collision))
  }
}
