import InertiaMiddleware from '#middleware/inertia_middleware'
import type { HttpContext } from '@adonisjs/core/http'

export function sharedFor(user: {
  email: string
  unverifiedEmail: string | null
  emailVerifiedAt: unknown
}) {
  const ctx = {
    auth: { user: { id: 1, fullName: null, ...user } },
    request: { plainCookie: () => 'light', header: () => undefined },
    inertia: { always: (value: unknown) => value },
    session: { flashMessages: { get: (_key: string, fallback: unknown) => fallback } },
  } as unknown as HttpContext
  return new InertiaMiddleware().share(ctx) as unknown as { emailVerified: boolean }
}
