import { test } from '@japa/runner'
import {
  invitationAcceptValidator,
  invitationListValidator,
  invitationSendValidator,
  profileUpdateValidator,
  signupValidator,
} from '../src/http/validators.js'
import { InvalidInputError } from '../src/errors.js'
import { managedErrorResponse } from '../src/http/responses.js'

test.group('managed request validation', () => {
  test('default field validators preserve configured registration data for service mapping', async ({
    assert,
  }) => {
    const registrationData = { fullName: 'New User' }
    for (const [validator, input] of [
      [
        signupValidator,
        { email: 'a@example.test', password: 'password123', passwordConfirmation: 'password123' },
      ],
      [invitationAcceptValidator, { password: 'password123', passwordConfirmation: 'password123' }],
      [profileUpdateValidator, { currentPassword: 'password123' }],
    ] as const) {
      const omitted = await validator.validate(input)
      assert.isFalse(Object.hasOwn(omitted, 'registrationData'))
      const output = await validator.validate({ ...input, registrationData })
      assert.deepEqual(output.registrationData, registrationData)
      try {
        await validator.validate({ ...input, registrationData: ['bad'] })
        assert.fail('expected object validation failure')
      } catch (error) {
        assert.equal((error as { status?: number }).status, 422)
      }
    }
  })
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
