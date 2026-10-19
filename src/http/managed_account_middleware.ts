import type { HttpContext } from '@adonisjs/core/http'
import type { AccountKit } from '../account_kit.js'
import type { ManagedGuard } from './managed.js'

/** Apply the same selected guard and package revision check to application-owned routes. */
export function managedAccountMiddleware<Credential>(options: {
  kit(): Promise<Pick<AccountKit, 'managedHttp' | 'authentication'>>
  guard: Pick<ManagedGuard<Credential>, 'current' | 'name' | 'strategy'>
  active: boolean
}): (context: HttpContext, next: () => Promise<unknown>) => Promise<unknown> {
  return async (context, next) => {
    const kit = await options.kit()
    kit.managedHttp.assertGuard(options.guard)
    const input = await options.guard.current(context)
    if (options.active) await kit.authentication.requireActive(input)
    else await kit.authentication.current(input)
    return next()
  }
}
