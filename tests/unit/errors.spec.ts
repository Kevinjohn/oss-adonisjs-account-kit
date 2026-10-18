import { test } from '@japa/runner'
import {
  AccountKitError,
  AuthorizationError,
  DeliveryError,
  EmailAlreadyRegisteredError,
  IdentityNotConfirmedError,
  InvalidInputError,
  InvalidTokenError,
  InvitationPendingError,
  NoPasswordError,
  PostCommitError,
  ThrottledError,
} from '../../src/errors.js'

test.group('account kit errors', () => {
  test('exposes stable class names and codes, retry timing, and causes', async ({ assert }) => {
    const errorTypes = [
      InvalidInputError,
      InvalidTokenError,
      AuthorizationError,
      IdentityNotConfirmedError,
      NoPasswordError,
      EmailAlreadyRegisteredError,
      InvitationPendingError,
      DeliveryError,
      PostCommitError,
    ]
    assert.isTrue(new AccountKitError('base').code === 'E_ACCOUNT_KIT')
    for (const ErrorType of errorTypes) {
      const error = new ErrorType('operation failed')
      assert.instanceOf(error, AccountKitError)
      assert.equal(error.name, ErrorType.name)
      assert.equal(error.code, ErrorType.code)
    }
    assert.equal(new ThrottledError(17).retryAfterSeconds, 17)
    const cause = new Error('callback failed')
    assert.equal(new DeliveryError('delivery failed', { cause }).cause, cause)
    assert.equal(new ThrottledError(17, 'rate limited', { cause }).cause, cause)
  })
})
