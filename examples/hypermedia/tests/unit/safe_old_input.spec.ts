import { test } from '@japa/runner'
import { safeOldInput } from '#exceptions/handler'

test('validation old input only contains bounded, application-approved text fields', ({
  assert,
}) => {
  const input = {
    fullName: 'Taylor Example',
    email: 'taylor@example.test',
    password: 'SignupPass123!',
    passwordConfirmation: 'SignupPass123!',
    currentPassword: 'CurrentPass123!',
    cancelCurrentPassword: 'CurrentPass123!',
    _csrf: 'secret-token',
    extra: 'unexpected value',
    tooLong: 'x'.repeat(321),
  }

  const oldInput = safeOldInput({ all: () => input } as never)

  assert.deepEqual(oldInput, {
    fullName: 'Taylor Example',
    email: 'taylor@example.test',
  })
})
