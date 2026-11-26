// Route middleware that admits only admitted accounts to application-owned routes.
import type { HttpContext } from '@adonisjs/core/http'
import type { ManagedGuard } from '../http/managed_types.ts'
import type { AccountAdmission } from './service.ts'

interface AdmissionMiddlewareOptions<Credential> {
  admission(): Promise<Pick<AccountAdmission, 'kit' | 'require'>>
  guard: Pick<ManagedGuard<Credential>, 'current' | 'name' | 'strategy'>
  active?: boolean
}

/**
 * Checks the selected guard, the credential revision and admission before `next`. With `active`
 * (the default) an unconfirmed account is refused first with `E_ACCOUNT_KIT_UNVERIFIED_EMAIL`.
 *
 * @example
 * ```ts
 * import AdmissionMiddleware from '@kevinjohn/adonisjs-account-kit/middleware/admission'
 * import app from '@adonisjs/core/services/app'
 * import { AccountAdmission } from '@kevinjohn/adonisjs-account-kit/admission'
 *
 * const requireAdmission = new AdmissionMiddleware({
 *   admission: () => app.container.make(AccountAdmission),
 *   guard,
 * })
 * ```
 */
export default class AdmissionMiddleware<Credential> {
  readonly #options: AdmissionMiddlewareOptions<Credential>

  constructor(options: AdmissionMiddlewareOptions<Credential>) {
    this.#options = options
  }

  /** @example
   * ```ts
   * return middleware.handle(ctx, next)
   * ```
   */
  async handle(context: HttpContext, next: () => Promise<unknown>): Promise<unknown> {
    const admission = await this.#options.admission()
    admission.kit.managedHttp.assertGuard(this.#options.guard)
    const input = await this.#options.guard.current(context)
    await admission.require(input, { active: this.#options.active ?? true })
    return next()
  }
}
