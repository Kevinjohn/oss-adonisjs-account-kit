import { test } from '@japa/runner'
import vine from '@vinejs/vine'
import { resetPasswordValidator } from '#validators/account'
import { loginValidator } from '#validators/user'

test('account validators use readable copy without changing unrelated Vine validators', async ({
  assert,
}) => {
  const [resetError] = await resetPasswordValidator.tryValidate({
    password: 'Password123!',
    passwordConfirmation: 'Different123!',
  })
  assert.exists(resetError)
  assert.include(resetError!.messages[0].message, 'Confirm password')
  assert.notInclude(resetError!.messages[0].message, 'passwordConfirmation')

  const [loginError] = await loginValidator.tryValidate({ email: 'not-an-email', password: '' })
  assert.exists(loginError)
  assert.include(loginError!.messages[0].message, 'email address')

  const unrelated = vine.create({ passwordConfirmation: vine.string().minLength(8) })
  const [unrelatedError] = await unrelated.tryValidate({ passwordConfirmation: 'short' })
  assert.exists(unrelatedError)
  assert.include(unrelatedError!.messages[0].message, 'passwordConfirmation')
  assert.notInclude(unrelatedError!.messages[0].message, 'Confirm password')
})
