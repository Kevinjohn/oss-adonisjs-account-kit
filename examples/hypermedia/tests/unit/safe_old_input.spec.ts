import { test } from '@japa/runner'
import { safeOldInput } from '#exceptions/handler'

test('validation old input retains fullName and email independently up to 320 characters', ({
  assert,
}) => {
  const input = {
    fullName: 'n'.repeat(320),
    email: 'e'.repeat(320),
    password: 'SignupPass123!',
    passwordConfirmation: 'SignupPass123!',
    currentPassword: 'CurrentPass123!',
    cancelCurrentPassword: 'CurrentPass123!',
    _csrf: 'secret-token',
    extra: 'unexpected value',
    unknown: 'unknown value',
  }

  const oldInput = safeOldInput({
    all: () => ({ ...input, nonString: { value: 'nested' } }),
  } as never)

  assert.deepEqual(oldInput, { fullName: input.fullName, email: input.email })

  for (const field of ['fullName', 'email'] as const) {
    const tooLong = safeOldInput({
      all: () => ({ [field]: 'x'.repeat(321) }),
    } as never)
    assert.notProperty(tooLong, field)
  }

  assert.notProperty(oldInput, 'password')
  assert.notProperty(oldInput, 'passwordConfirmation')
  assert.notProperty(oldInput, 'currentPassword')
  assert.notProperty(oldInput, 'cancelCurrentPassword')
  assert.notProperty(oldInput, '_csrf')
  assert.notProperty(oldInput, 'unknown')
  assert.notProperty(oldInput, 'nonString')
})

test('validation old input omits nonstring safe fields', ({ assert }) => {
  for (const field of ['fullName', 'email'] as const) {
    const oldInput = safeOldInput({
      all: () => ({ [field]: { value: 'nested' } }),
    } as never)
    assert.notProperty(oldInput, field)
  }
})
