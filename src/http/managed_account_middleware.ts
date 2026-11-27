import type { HttpContext } from '@adonisjs/core/http'
import type { AccountKit } from '../account_kit.ts'
import type { ManagedGuard } from './managed.ts'

interface ManagedAccountMiddlewareOptions<Credential> {
  kit(): Promise<Pick<AccountKit, 'managedHttp' | 'authentication'>>
  guard: Pick<ManagedGuard<Credential>, 'current' | 'name' | 'strategy'>
  active: boolean
}

/**
 * Apply the same selected guard and package revision check to application-owned routes.
 *
 * @example
 * ```ts
 * import ManagedAccountMiddleware from '@kevinjohn/adonisjs-account-kit/middleware/managed_account'
 * import app from '@adonisjs/core/services/app'
 * import { AccountKit } from '@kevinjohn/adonisjs-account-kit'
 *
 * const activeAccount = new ManagedAccountMiddleware({
 *   kit: () => app.container.make(AccountKit),
 *   guard,
 *   active: true,
 * })
 * ```
 */
export default class ManagedAccountMiddleware<Credential> {
  readonly #options: ManagedAccountMiddlewareOptions<Credential>

  constructor(options: ManagedAccountMiddlewareOptions<Credential>) {
    this.#options = options
  }

  /** @example
   * ```ts
   * return middleware.handle(ctx, next)
   * ```
   *
   * @throws {AggregateError} If transaction work and cleanup fail before a commit is confirmed.
   */
  async handle(context: HttpContext, next: () => Promise<unknown>): Promise<unknown> {
    const kit = await this.#options.kit()
    kit.managedHttp.assertGuard(this.#options.guard)
    const input = await this.#options.guard.current(context)
    if (this.#options.active) await kit.authentication.requireActive(input)
    else await kit.authentication.current(input)
    return next()
  }
}
