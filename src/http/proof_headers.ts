import type { HttpContext } from '@adonisjs/core/http'
import { planManagedRoutes, type ManagedRouteSelection } from './routes.js'

export function proofHeaders(): Record<string, string> {
  return { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }
}

export function applyProofHeaders(response: HttpContext['response']): void {
  for (const [name, value] of Object.entries(proofHeaders())) response.header(name, value)
}

function matchesPath(pattern: string, path: string): boolean {
  const parts = (value: string) => value.replace(/\/+$/, '').split('/').filter(Boolean)
  const expected = parts(pattern)
  const actual = parts(path)
  return (
    expected.length === actual.length &&
    expected.every((part, index) =>
      part.startsWith(':') ? Boolean(actual[index]) : part === actual[index]
    )
  )
}

/** Install before body-parser and Shield so proof URL failures retain protective headers. */
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
