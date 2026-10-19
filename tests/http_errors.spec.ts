import { test } from '@japa/runner'
import {
  AccountKitError,
  AuthorizationError,
  DeliveryError,
  InvitationManagementDeniedError,
  InvitationNotFoundError,
  PostCommitError,
  ThrottledError,
} from '../src/errors.js'
import { accountErrorResponse } from '../src/error_response.js'

test.group('account HTTP error mapping', () => {
  test('maps status and stable error code while keeping causes private', ({ assert }) => {
    const cause = new Error('database password and query details')
    const error = new DeliveryError('secret provider response', { cause })
    const response = accountErrorResponse(error)!
    assert.equal(response.status, 500)
    assert.equal(response.body.code, DeliveryError.code)
    assert.equal(response.body.message, 'Account operation failed')
    assert.deepEqual(response.headers, {})
    assert.equal(error.cause, cause)
    assert.notInclude(JSON.stringify(response), 'database password')
    assert.notInclude(JSON.stringify(response), 'secret provider response')
  })

  test('uses one indistinguishable 404 response for missing and denied invitations', ({
    assert,
  }) => {
    const missing = accountErrorResponse(new InvitationNotFoundError())!
    const denied = accountErrorResponse(new InvitationManagementDeniedError())!
    assert.deepEqual(denied, missing)
    assert.equal(missing.status, 404)
    assert.equal(missing.body.code, InvitationNotFoundError.code)
    assert.equal(missing.body.message, 'Invitation not found')
  })

  test('maps public error statuses and returns a rounded-up Retry-After value', ({ assert }) => {
    assert.equal(accountErrorResponse(new AuthorizationError())?.status, 403)
    assert.equal(accountErrorResponse(new AccountKitError())?.status, 500)
    assert.equal(accountErrorResponse(new ThrottledError(1.2))?.headers['Retry-After'], '2')
    assert.equal(accountErrorResponse(new ThrottledError(0))?.headers['Retry-After'], '1')
  })

  test('marks committed post-commit failures in the response body', ({ assert }) => {
    const cause = new Error('listener failed after commit')
    const error = new PostCommitError('post-commit hook failed', { cause })
    const response = accountErrorResponse(error)!
    assert.equal(error.cause, cause)
    assert.equal(error.committed, true)
    assert.deepEqual(response.body, {
      code: PostCommitError.code,
      message: 'Account operation failed',
      committed: true,
    })
    assert.notInclude(JSON.stringify(response), 'listener failed')
  })

  test('returns null for errors outside the package contract', ({ assert }) => {
    assert.isNull(accountErrorResponse(new Error('unmapped')))
    assert.isNull(accountErrorResponse({ code: 'E_ACCOUNT_KIT_FAKE', status: 500 }))
  })

  test('looks up the message as errors.<code> through i18n after normalising the code', ({
    assert,
  }) => {
    const french: Record<string, string> = {
      'errors.E_ACCOUNT_KIT_INVITATION_NOT_FOUND': 'Invitation introuvable',
      'errors.E_ACCOUNT_KIT_DELIVERY': "L'opération a échoué",
    }
    const lookups: string[] = []
    const i18n = {
      t: (identifier: string, _data: Record<string, unknown>, fallbackMessage: string) => {
        lookups.push(identifier)
        return french[identifier] ?? fallbackMessage
      },
    }
    const missing = accountErrorResponse(new InvitationNotFoundError(), { i18n })!
    const denied = accountErrorResponse(new InvitationManagementDeniedError(), { i18n })!
    assert.deepEqual(denied, missing)
    assert.equal(missing.body.message, 'Invitation introuvable')
    assert.equal(
      accountErrorResponse(new DeliveryError(), { i18n })!.body.message,
      "L'opération a échoué"
    )
    assert.equal(
      accountErrorResponse(new AuthorizationError(), { i18n })!.body.message,
      'Account request rejected'
    )
    assert.notInclude(lookups, 'errors.E_ACCOUNT_KIT_INVITATION_MANAGEMENT_DENIED')
    assert.include(lookups, 'errors.E_ACCOUNT_KIT_AUTHORIZATION')
    assert.equal(
      accountErrorResponse(new DeliveryError())!.body.message,
      'Account operation failed'
    )
  })
})
