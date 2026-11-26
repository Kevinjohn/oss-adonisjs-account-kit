import HttpExceptionHandler from '#exceptions/handler'
import { formContext } from '#tests/helpers/unit_csrf_flash'
import { errors as shieldErrors } from '@adonisjs/shield'
import { test } from '@japa/runner'

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
