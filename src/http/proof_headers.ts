import type { HttpContext } from '@adonisjs/core/http'
import { planManagedRoutes, type ManagedRouteSelection } from './routes.js'

export function buildProofHeaders(): Record<string, string> {
  return { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }
}

export function applyProofHeaders(response: HttpContext['response']): void {
  for (const [name, value] of Object.entries(buildProofHeaders())) response.header(name, value)
}

function matchesPath(pattern: string, path: string): boolean {
  const splitPathSegments = (value: string) => value.replace(/\/+$/, '').split('/').filter(Boolean)
  const expected = splitPathSegments(pattern)
  const actual = splitPathSegments(path)
  return (
    expected.length === actual.length &&
    expected.every((part, index) =>
      part.startsWith(':') ? Boolean(actual[index]) : part === actual[index]
    )
  )
}

/**
 * Install before body-parser and Shield so proof URL failures retain protective headers.
 *
 * @example
 * ```ts
 * import { managedProofHeadersMiddleware } from '@kevinjohn/adonisjs-account-kit/http'
 * import server from '@adonisjs/core/services/server'
 *
 * const proofHeaders = managedProofHeadersMiddleware({
 *   prefix: '/account',
 *   strategy: 'session',
 *   enabled: ['passwordReset'],
 * })
 * class AccountProofHeadersMiddleware {
 *   handle = proofHeaders
 * }
 *
 * server.use([async () => ({ default: AccountProofHeadersMiddleware })])
 * ```
 */
export function managedProofHeadersMiddleware(selection: ManagedRouteSelection) {
  const proofs = planManagedRoutes(selection).filter((route) => route.proof)
  return async (context: HttpContext, next: () => Promise<unknown>): Promise<unknown> => {
    const method = context.request.method()
    const path = context.request.url().split('?')[0]
    if (proofs.some((route) => route.method === method && matchesPath(route.path, path)))
      applyProofHeaders(context.response)
    return next()
  }
}
