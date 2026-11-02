import { randomUUID } from 'node:crypto'
import { test } from '@japa/runner'
import { signupValidator } from '#validators/user'

test('signup accepts an optional trimmed full name up to 255 characters', async ({ assert }) => {
  const email = `signup-${randomUUID()}@example.test`
  const valid = (fullName: unknown) =>
    signupValidator.tryValidate({
      fullName,
      email,
      password: 'SignupPass123!',
      passwordConfirmation: 'SignupPass123!',
    })

  for (const fullName of [undefined, null, '', '   ']) {
    const [error] = await valid(fullName)
    assert.isNull(error, `expected ${String(fullName)} to pass`)
  }

  const [tooLongError] = await valid('x'.repeat(256))
  assert.exists(tooLongError)
  assert.equal(tooLongError!.messages[0]!.field, 'fullName')
  const [error, output] = await valid(`  ${'x'.repeat(255)}  `)
  assert.isNull(error)
  assert.equal(output!.fullName, 'x'.repeat(255))
})
