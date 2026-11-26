import type { HttpContext } from '@adonisjs/core/http'
import { planManagedRoutes, type ManagedRouteSelection } from './routes.ts'
import { applyProofHeaders } from './proof_headers.ts'

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
 * import ManagedProofHeadersMiddleware from '@kevinjohn/adonisjs-account-kit/middleware/proof_headers'
 * import server from '@adonisjs/core/services/server'
 *
 * const proofHeaders = new ManagedProofHeadersMiddleware({
 *   prefix: '/account',
 *   strategy: 'session',
 *   enabled: ['passwordReset'],
 * })
 * class AccountProofHeadersMiddleware {
 *   handle = proofHeaders.handle.bind(proofHeaders)
 * }
 *
 * server.use([async () => ({ default: AccountProofHeadersMiddleware })])
 * ```
 */
export default class ManagedProofHeadersMiddleware {
  readonly #proofs: ReturnType<typeof planManagedRoutes>

  constructor(selection: ManagedRouteSelection) {
    this.#proofs = planManagedRoutes(selection).filter((route) => route.proof)
  }

  /** @example
   * ```ts
   * return proofHeaders.handle(ctx, next)
   * ```
   */
  async handle(context: HttpContext, next: () => Promise<unknown>): Promise<unknown> {
    const method = context.request.method()
    const path = context.request.url().split('?')[0]
    if (this.#proofs.some((route) => route.method === method && matchesPath(route.path, path)))
      applyProofHeaders(context.response)
    return next()
  }
}
