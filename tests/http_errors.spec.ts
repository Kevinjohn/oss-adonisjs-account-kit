import { readFile } from 'node:fs/promises'
import { test } from '@japa/runner'
import * as errors from '../src/errors.js'
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
import { managedErrorResponse } from '../src/http/responses.js'

const operationFailed = 'E_ACCOUNT_KIT_OPERATION_FAILED'

test.group('account HTTP error mapping', () => {
  test('maps status and stable error code while keeping causes private', ({ assert }) => {
    const cause = new Error('database password and query details')
    const error = new DeliveryError('secret provider response', { cause })
    const response = accountErrorResponse(error)!
    assert.equal(response.status, 500)
    assert.deepEqual(response.body, {
      errors: [{ code: operationFailed, message: 'Account operation failed.' }],
    })
    assert.deepEqual(response.headers, { 'Cache-Control': 'no-store' })
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
    assert.deepEqual(missing.body.errors, [
      { code: 'E_ACCOUNT_KIT_INVITATION_NOT_FOUND', message: 'Invitation not found.' },
    ])
  })

  test('maps public error statuses and returns a rounded-up Retry-After value', ({ assert }) => {
    assert.equal(accountErrorResponse(new AuthorizationError())?.status, 403)
    assert.deepEqual(accountErrorResponse(new AuthorizationError())?.body.errors, [
      { code: 'E_ACCOUNT_KIT_FORBIDDEN', message: 'Access denied.' },
    ])
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
      errors: [{ code: operationFailed, message: 'Account operation failed.', committed: true }],
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
      'errors.E_ACCOUNT_KIT_OPERATION_FAILED': "L'opération a échoué",
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
    assert.equal(missing.body.errors[0].message, 'Invitation introuvable')
    assert.equal(
      accountErrorResponse(new DeliveryError(), { i18n })!.body.errors[0].message,
      "L'opération a échoué"
    )
    assert.equal(
      accountErrorResponse(new AuthorizationError(), { i18n })!.body.errors[0].message,
      'Access denied.'
    )
    assert.notInclude(lookups, 'errors.E_ACCOUNT_KIT_INVITATION_MANAGEMENT_DENIED')
    assert.include(lookups, 'errors.E_ACCOUNT_KIT_FORBIDDEN')
    assert.equal(
      accountErrorResponse(new DeliveryError())!.body.errors[0].message,
      'Account operation failed.'
    )
  })

  test('the helper and the managed renderer produce the same entry for every package error', ({
    assert,
  }) => {
    for (const ErrorClass of Object.values(errors)) {
      if (
        ErrorClass !== errors.AccountKitError &&
        !(ErrorClass.prototype instanceof errors.AccountKitError)
      )
        continue
      const error =
        ErrorClass === errors.ThrottledError
          ? new errors.ThrottledError(1)
          : new (ErrorClass as new () => Error)()
      const helper = accountErrorResponse(error)!
      const managed = managedErrorResponse(error)!
      assert.equal(helper.status, managed.status, ErrorClass.name)
      assert.deepEqual(helper.body.errors[0], managed.body.errors[0], ErrorClass.name)
    }
  })

  test('the documented errors.json lists every returned code with its English message', async ({
    assert,
  }) => {
    const docs = await readFile(new URL('../docs/reference/errors.md', import.meta.url), 'utf8')
    const block = docs
      .split('resources/lang/<locale>/errors.json')[1]
      ?.match(/```json\n([\s\S]*?)```/)
    const documented = JSON.parse(block![1])
    const actual: Record<string, string> = {}
    for (const ErrorClass of Object.values(errors)) {
      if (
        ErrorClass !== errors.AccountKitError &&
        !(ErrorClass.prototype instanceof errors.AccountKitError)
      )
        continue
      const error =
        ErrorClass === errors.ThrottledError
          ? new errors.ThrottledError(1)
          : new (ErrorClass as new () => Error)()
      const entry = accountErrorResponse(error)!.body.errors[0]
      actual[entry.code] = entry.message
    }
    assert.deepEqual(documented, actual)
  })
})
