import { test } from '@japa/runner'
import { invitationListValidator, invitationSendValidator } from '../src/http/validators.js'
import { InvalidInputError } from '../src/errors.js'
import { managedErrorResponse } from '../src/http/responses.js'

test.group('managed request validation', () => {
  test('invitation role is bounded at the HTTP boundary', async ({ assert }) => {
    try {
      await invitationSendValidator.validate({ email: 'a@example.test', role: 'x'.repeat(65) })
      assert.fail('expected validation failure')
    } catch (error) {
      assert.equal((error as { status?: number }).status, 422)
    }
  })

  test('invitation list limit must be an integer', async ({ assert }) => {
    try {
      await invitationListValidator.validate({ limit: 1.5 })
      assert.fail('expected validation failure')
    } catch (error) {
      assert.equal((error as { status?: number }).status, 422)
    }
  })

  test('password-policy rejection is never misreported as invalid proof', ({ assert }) => {
    const response = managedErrorResponse(new InvalidInputError('Invalid password'), {
      proof: 'password',
    })
    assert.equal(response?.body.errors[0].code, 'E_ACCOUNT_KIT_INVALID_INPUT')
  })
})
