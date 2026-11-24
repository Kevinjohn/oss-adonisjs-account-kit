import { test } from '@japa/runner'
import {
  E_ACCOUNT_KIT_ACCOUNT_ACCESS_DENIED,
  E_ACCOUNT_KIT,
  E_ACCOUNT_KIT_ADAPTER_CONTRACT,
  E_ACCOUNT_KIT_AUTHORIZATION,
  E_ACCOUNT_KIT_DELIVERY,
  E_ACCOUNT_KIT_EMAIL_ALREADY_REGISTERED,
  E_ACCOUNT_KIT_IDENTITY_NOT_CONFIRMED,
  E_INVALID_CREDENTIALS,
  E_ACCOUNT_KIT_INVALID_INPUT,
  E_ACCOUNT_KIT_INVALID_TOKEN,
  E_ACCOUNT_KIT_INVITATION_PENDING,
  E_ACCOUNT_KIT_NO_PASSWORD,
  E_ACCOUNT_KIT_POST_COMMIT,
  E_ACCOUNT_KIT_THROTTLED,
} from '../src/errors.js'

test.group('account kit errors', () => {
  test('inspection denial has one generic public identity without an authorization cause', ({
    assert,
  }) => {
    const error = new E_ACCOUNT_KIT_ACCOUNT_ACCESS_DENIED()
    assert.equal(error.code, 'E_ACCOUNT_KIT_ACCOUNT_ACCESS_DENIED')
    assert.equal(error.status, 403)
    assert.equal(error.message, 'Account access denied')
    assert.instanceOf(error, E_ACCOUNT_KIT)
    assert.notInstanceOf(error, E_ACCOUNT_KIT_AUTHORIZATION)
    assert.isUndefined(error.cause)
  })
  test('class statuses are the documented HTTP contract', ({ assert }) => {
    assert.equal(new E_INVALID_CREDENTIALS().status, 401)
    assert.equal(new E_ACCOUNT_KIT_INVALID_TOKEN().status, 400)
  })
  test('exposes stable class names and codes, retry timing, and causes', async ({ assert }) => {
    const errorTypes = [
      E_ACCOUNT_KIT_INVALID_INPUT,
      E_ACCOUNT_KIT_INVALID_TOKEN,
      E_ACCOUNT_KIT_AUTHORIZATION,
      E_ACCOUNT_KIT_IDENTITY_NOT_CONFIRMED,
      E_ACCOUNT_KIT_NO_PASSWORD,
      E_ACCOUNT_KIT_EMAIL_ALREADY_REGISTERED,
      E_ACCOUNT_KIT_INVITATION_PENDING,
      E_ACCOUNT_KIT_DELIVERY,
      E_ACCOUNT_KIT_POST_COMMIT,
      E_ACCOUNT_KIT_ADAPTER_CONTRACT,
    ]
    assert.isTrue(new E_ACCOUNT_KIT('base').code === 'E_ACCOUNT_KIT')
    for (const ErrorType of errorTypes) {
      const error = new ErrorType('operation failed')
      assert.instanceOf(error, E_ACCOUNT_KIT)
      assert.equal(error.name, ErrorType.name)
      assert.equal(error.code, ErrorType.code)
    }
    assert.equal(new E_ACCOUNT_KIT_THROTTLED(17).retryAfterSeconds, 17)
    const cause = new Error('callback failed')
    assert.equal(new E_ACCOUNT_KIT_DELIVERY('delivery failed', { cause }).cause, cause)
    assert.equal(new E_ACCOUNT_KIT_THROTTLED(17, { cause }).cause, cause)
  })
  test('exposes the translation identifier from the public error code', ({ assert }) => {
    assert.equal(new E_ACCOUNT_KIT_THROTTLED(1).identifier, 'errors.E_ACCOUNT_KIT_THROTTLED')

    class CustomThrottledError extends E_ACCOUNT_KIT_THROTTLED {
      static code = 'E_CUSTOM_THROTTLED'
    }

    assert.equal(new CustomThrottledError(1).identifier, 'errors.E_CUSTOM_THROTTLED')
  })
})
