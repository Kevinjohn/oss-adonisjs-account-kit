import app from '@adonisjs/core/services/app'
import type { HttpContext } from '@adonisjs/core/http'
import type { SocialProviderName } from 'adonisjs-account-kit'

type Method = 'password' | SocialProviderName
const cookieName = 'account_kit_last_method'

/** A signed visitor preference; it contains no account identity and grants no access. */
export function rememberLastUsedMethod(ctx: HttpContext, method: Method) {
  try {
    ctx.response.cookie(cookieName, method, {
      httpOnly: true,
      secure: app.inProduction,
      sameSite: 'lax',
      path: '/',
      maxAge: '30d',
    })
  } catch {
    // A visitor hint cannot turn an established credential into a reported failure.
  }
}

export function lastUsedMethod(
  ctx: HttpContext,
  options: { password: boolean; providers: readonly string[] }
): Method | null {
  const value: unknown = ctx.request.cookie(cookieName)
  if (value === 'password') return options.password ? 'password' : null
  if (typeof value === 'string' && options.providers.includes(value))
    return value as SocialProviderName
  return null
}
