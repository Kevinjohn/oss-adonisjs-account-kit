import { test } from '@japa/runner'
import { safeOldInput } from '#services/safe_old_input'

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
    ...input,
    nonString: { value: 'nested' },
  })

  assert.deepEqual(oldInput, { fullName: input.fullName, email: input.email })

  for (const field of ['fullName', 'email'] as const) {
    const tooLong = safeOldInput({
      [field]: 'x'.repeat(321),
    })
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

test('validation old input omits unsupported object values', ({ assert }) => {
  for (const field of ['fullName', 'email'] as const) {
    const oldInput = safeOldInput({
      [field]: { value: 'nested' },
    })
    assert.notProperty(oldInput, field)
  }
})

test('safe old input distinguishes absent fields from cleared fields', ({ assert }) => {
  assert.deepEqual(safeOldInput({}), {})
  assert.deepEqual(safeOldInput({ fullName: null, email: '' }), { fullName: '', email: '' })
  assert.deepEqual(safeOldInput({ fullName: '', email: null }), { fullName: '', email: '' })
  assert.deepEqual(safeOldInput({ fullName: undefined, email: 42, password: null }), {})
})
