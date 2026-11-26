import type { HttpContext } from '@adonisjs/core/http'

/** A form post with camelCase secrets in the body, sent by Inertia or as a plain form. */
export function formContext(inertia: boolean) {
  const flashed: unknown[] = []
  const ctx = {
    request: {
      header: (name: string) => (inertia && name === 'X-Inertia' ? 'true' : undefined),
      method: () => 'POST',
      url: () => '/settings/password',
      all: () => ({
        currentPassword: 'CurrentSecret123!',
        password: 'NewSecret123!',
        passwordConfirmation: 'NewSecret123!',
        email: 'owner@example.test',
      }),
    },
    session: {
      flash: (...args: unknown[]) => flashed.push(['flash', ...args]),
      flashErrors: (...args: unknown[]) => flashed.push(['flashErrors', ...args]),
      flashOnly: (...args: unknown[]) => flashed.push(['flashOnly', ...args]),
      flashExcept: (...args: unknown[]) => flashed.push(['flashExcept', ...args]),
    },
    response: { redirect: () => ({ back: () => undefined }) },
  } as unknown as HttpContext
  return { ctx, flashed }
}
