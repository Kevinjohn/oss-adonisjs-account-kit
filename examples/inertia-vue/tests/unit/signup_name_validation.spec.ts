import { randomUUID } from 'node:crypto'
import { test } from '@japa/runner'
import { signupValidator } from '#validators/user'

test('signup requires a trimmed full name of 1 to 255 characters', async ({ assert }) => {
  const email = `signup-${randomUUID()}@example.test`
  const valid = (fullName: unknown) =>
    signupValidator.tryValidate({
      fullName,
      email,
      password: 'SignupPass123!',
      passwordConfirmation: 'SignupPass123!',
    })

  for (const fullName of [undefined, null, '', '   ', 'x'.repeat(256)]) {
    const [error] = await valid(fullName)
    assert.exists(error, `expected ${String(fullName)} to fail`)
    assert.equal(error!.messages[0]!.field, 'fullName')
  }

  const [error, output] = await valid(`  ${'x'.repeat(255)}  `)
  assert.isNull(error)
  assert.equal(output!.fullName, 'x'.repeat(255))
})
