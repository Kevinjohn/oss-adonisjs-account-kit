import { test } from '@japa/runner'
import type { HttpContext } from '@adonisjs/core/http'
import { errors as shieldErrors } from '@adonisjs/shield'
import HttpExceptionHandler from '#exceptions/handler'

/** A form post with camelCase secrets in the body, sent by Inertia or as a plain form. */
function formContext(inertia: boolean) {
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

test.group('CSRF failure flash', () => {
  for (const inertia of [true, false])
    test(`${inertia ? 'an Inertia' : 'a plain'} form post keeps only non-secret fields`, async ({
      assert,
    }) => {
      const { ctx, flashed } = formContext(inertia)
      await new HttpExceptionHandler().handle(new shieldErrors.E_BAD_CSRF_TOKEN(), ctx)
      assert.notInclude(
        flashed.map((entry) => (entry as unknown[])[0]),
        'flashExcept'
      )
      assert.deepInclude(flashed, ['flashOnly', ['fullName', 'email']])
    })
})
