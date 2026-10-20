import type { HttpContext } from '@adonisjs/core/http'
import type { NextFn } from '@adonisjs/core/types/http'
import { selectedGuardName } from '#services/auth_strategy'

/**
 * Silent auth middleware can be used as a global middleware to silent check
 * if the user is logged-in or not.
 *
 * The request continues as usual, even when the user is not logged-in.
 *
 * No route in this example needs it; it stays so the example keeps the AdonisJS starter's
 * middleware stack, as the Inertia example does. It checks the selected guard rather than the
 * default one because the example switches between session and access-token auth.
 */
export default class SilentAuthMiddleware {
  async handle(ctx: HttpContext, next: NextFn) {
    await ctx.auth.use(selectedGuardName()).check()

    return next()
  }
}
