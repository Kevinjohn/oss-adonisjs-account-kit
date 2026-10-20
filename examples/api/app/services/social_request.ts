import type { HttpContext } from '@adonisjs/core/http'
import type { CurrentAccountInput } from 'adonisjs-account-kit'
import { accountInput } from '#services/account_input'
import { selectedGuardName } from '#services/auth_strategy'

export async function currentIfAuthenticated(
  ctx: HttpContext
): Promise<CurrentAccountInput | undefined> {
  const guard = ctx.auth.use(selectedGuardName())
  return (await guard.check()) ? accountInput(ctx) : undefined
}
