import type { HttpContext } from '@adonisjs/core/http'
import { InvalidInputError, type CurrentAccountInput } from 'adonisjs-account-kit'
import { accountInput } from '#services/account_input'
import { selectedGuardName } from '#services/auth_strategy'

export function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new InvalidInputError(`Missing ${field}`)
  }
  return value
}

export async function currentIfAuthenticated(
  ctx: HttpContext
): Promise<CurrentAccountInput | undefined> {
  const guard = ctx.auth.use(selectedGuardName())
  return (await guard.check()) ? accountInput(ctx) : undefined
}
