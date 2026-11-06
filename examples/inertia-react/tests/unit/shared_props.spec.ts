import { test } from '@japa/runner'
import type { HttpContext } from '@adonisjs/core/http'
import InertiaMiddleware from '#middleware/inertia_middleware'

function sharedFor(user: {
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

test.group('Shared Inertia props', () => {
  test('emailVerified follows the package rule, not emailVerifiedAt', ({ assert }) => {
    // An existing user from before the migration: both columns are null, and the account is active.
    assert.isTrue(
      sharedFor({ email: 'old@example.test', unverifiedEmail: null, emailVerifiedAt: null })
        .emailVerified
    )
    assert.isFalse(
      sharedFor({
        email: 'new@example.test',
        unverifiedEmail: 'new@example.test',
        emailVerifiedAt: null,
      }).emailVerified
    )
  })
})
