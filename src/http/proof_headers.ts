import type { HttpContext } from '@adonisjs/core/http'
import { proofHeaders } from './responses.js'
import { planManagedRoutes, type ManagedRouteSelection } from './routes.js'

type ProofSelection = Pick<ManagedRouteSelection, 'prefix' | 'enabled' | 'except'>

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
export function managedProofHeadersMiddleware(selection: ProofSelection) {
  const proofs = planManagedRoutes({ ...selection, strategy: 'session' }).filter(
    (route) => route.proof
  )
  return async (context: HttpContext, next: () => Promise<unknown>): Promise<unknown> => {
    const method = context.request.method()
    const path = context.request.url().split('?')[0]
    if (proofs.some((route) => route.method === method && matchesPath(route.path, path))) {
      for (const [name, value] of Object.entries(proofHeaders()))
        context.response.header(name, value)
    }
    return next()
  }
}
