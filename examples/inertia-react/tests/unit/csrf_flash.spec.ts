import { test } from '@japa/runner'
import type { HttpContext } from '@adonisjs/core/http'
import { errors as shieldErrors } from '@adonisjs/shield'
import HttpExceptionHandler from '#exceptions/handler'

/** A plain form post: no X-Inertia header, camelCase secrets in the body. */
function plainFormContext() {
  const flashed: unknown[] = []
  const ctx = {
    request: {
      header: () => undefined,
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

test.group('CSRF failure flash', () => {
  test('a plain form post keeps only non-secret fields', async ({ assert }) => {
    const { ctx, flashed } = plainFormContext()
    await new HttpExceptionHandler().handle(new shieldErrors.E_BAD_CSRF_TOKEN(), ctx)
    assert.notInclude(
      flashed.map((entry) => (entry as unknown[])[0]),
      'flashExcept'
    )
    assert.deepInclude(flashed, ['flashOnly', ['fullName', 'email']])
  })
})
