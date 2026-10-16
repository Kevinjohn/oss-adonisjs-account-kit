import type { HttpContext } from '@adonisjs/core/http'
import { InvalidInputError, type CurrentAccountInput } from 'adonisjs-account-kit'
import env from '#start/env'
import { accountInput } from '#middleware/account_access_middleware'

export const socialStrategy = () => env.get('ACCOUNT_KIT_AUTH_STRATEGY') ?? 'access_tokens'

export function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new InvalidInputError(`Missing ${field}`)
  }
  return value
}

export async function currentIfAuthenticated(
  ctx: HttpContext
): Promise<CurrentAccountInput | undefined> {
  const guard = ctx.auth.use(socialStrategy() === 'session' ? 'web' : 'api')
  return (await guard.check()) ? accountInput(ctx) : undefined
}
