// Route middleware that admits only admitted accounts to application-owned routes.
import type { HttpContext } from '@adonisjs/core/http'
import type { ManagedGuard } from '../http/managed_types.js'
import type { AccountAdmission } from './service.js'

/**
 * Checks the selected guard, the credential revision and admission before `next`. With `active`
 * (the default) an unconfirmed account is refused first with `UnverifiedEmailError`.
 */
export function admissionMiddleware<Credential>(options: {
  admission(): Promise<Pick<AccountAdmission, 'kit' | 'require'>>
  guard: Pick<ManagedGuard<Credential>, 'current' | 'name' | 'strategy'>
  active?: boolean
}): (context: HttpContext, next: () => Promise<unknown>) => Promise<unknown> {
  return async (context, next) => {
    const admission = await options.admission()
    admission.kit.managedHttp.assertGuard(options.guard)
    const input = await options.guard.current(context)
    await admission.require(input, { active: options.active ?? true })
    return next()
  }
}
