import { readFile } from 'node:fs/promises'
import { test } from '@japa/runner'
import * as errors from '../src/errors.ts'
import {
  E_ACCOUNT_KIT,
  E_ACCOUNT_KIT_ADAPTER_CONTRACT,
  E_ACCOUNT_KIT_AUTHORIZATION,
  E_ACCOUNT_KIT_DELIVERY,
  E_ACCOUNT_KIT_EMAIL_ALREADY_REGISTERED,
  E_ACCOUNT_KIT_INVITATION_MANAGEMENT_DENIED,
  E_ACCOUNT_KIT_INVITATION_NOT_FOUND,
  E_ACCOUNT_KIT_INVALID_TOKEN,
  E_ACCOUNT_KIT_POST_COMMIT,
  E_ACCOUNT_KIT_REGISTRATION_EMAIL_ALREADY_REGISTERED,
  E_ACCOUNT_KIT_THROTTLED,
} from '../src/errors.ts'
import { accountErrorResponse, type AccountErrorResponse } from '../src/error_response.ts'
import { mapManagedErrorResponse } from '../src/http/responses.ts'

const operationFailed = 'E_ACCOUNT_KIT_OPERATION_FAILED'

/** The first entry's wording: `message` in plain JSON, `title` in JSON:API. */
function messageOf(response: AccountErrorResponse): string {
  const entry = response.body.errors[0]
  return 'message' in entry ? entry.message : entry.title
}

test.group('account HTTP error mapping', () => {
  test('maps status and stable error code while keeping causes private', ({ assert }) => {
    const cause = new Error('database password and query details')
    const error = new E_ACCOUNT_KIT_DELIVERY('secret provider response', { cause })
    const response = accountErrorResponse(error)!
    assert.equal(response.status, 500)
    assert.deepEqual(response.body, {
      errors: [{ code: operationFailed, message: 'Account operation failed.' }],
    })
    assert.deepEqual(response.headers, { 'Vary': 'Accept', 'Cache-Control': 'no-store' })
    assert.equal(error.cause, cause)
    assert.notInclude(JSON.stringify(response), 'database password')
    assert.notInclude(JSON.stringify(response), 'secret provider response')
  })

  test('uses one indistinguishable 404 response for missing and denied invitations', ({
    assert,
  }) => {
    const missing = accountErrorResponse(new E_ACCOUNT_KIT_INVITATION_NOT_FOUND())!
    const denied = accountErrorResponse(new E_ACCOUNT_KIT_INVITATION_MANAGEMENT_DENIED())!
    assert.deepEqual(denied, missing)
    assert.equal(missing.status, 404)
    assert.deepEqual(missing.body.errors, [
      { code: 'E_ACCOUNT_KIT_INVITATION_NOT_FOUND', message: 'Invitation not found.' },
    ])
  })

  test('maps public error statuses and returns a rounded-up Retry-After value', ({ assert }) => {
    assert.equal(accountErrorResponse(new E_ACCOUNT_KIT_AUTHORIZATION())?.status, 403)
    assert.deepEqual(accountErrorResponse(new E_ACCOUNT_KIT_AUTHORIZATION())?.body.errors, [
      { code: 'E_ACCOUNT_KIT_FORBIDDEN', message: 'Access denied.' },
    ])
    assert.equal(accountErrorResponse(new E_ACCOUNT_KIT())?.status, 500)
    assert.equal(
      accountErrorResponse(new E_ACCOUNT_KIT_THROTTLED(1.2))?.headers['Retry-After'],
      '2'
    )
    assert.equal(accountErrorResponse(new E_ACCOUNT_KIT_THROTTLED(0))?.headers['Retry-After'], '1')
  })

  test('marks committed post-commit failures in the response body', ({ assert }) => {
    const cause = new Error('listener failed after commit')
    const error = new E_ACCOUNT_KIT_POST_COMMIT('post-commit hook failed', { cause })
    const response = accountErrorResponse(error)!
    assert.equal(error.cause, cause)
    assert.equal(error.committed, true)
    assert.deepEqual(response.body, {
      errors: [{ code: operationFailed, message: 'Account operation failed.', committed: true }],
    })
    assert.notInclude(JSON.stringify(response), 'listener failed')
  })

  test('masks an adapter contract violation as the generic operation failure', ({ assert }) => {
    const error = new E_ACCOUNT_KIT_ADAPTER_CONTRACT(
      'account_kit: canAccess must resolve to a boolean'
    )
    assert.equal(error.code, 'E_ACCOUNT_KIT_ADAPTER_CONTRACT')
    const response = mapManagedErrorResponse(error)!
    assert.equal(response.status, 500)
    assert.deepEqual(response.body, {
      errors: [{ code: operationFailed, message: 'Account operation failed.' }],
    })
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
    const missing = accountErrorResponse(new E_ACCOUNT_KIT_INVITATION_NOT_FOUND(), { i18n })!
    const denied = accountErrorResponse(new E_ACCOUNT_KIT_INVITATION_MANAGEMENT_DENIED(), { i18n })!
    assert.deepEqual(denied, missing)
    assert.equal(messageOf(missing), 'Invitation introuvable')
    assert.equal(
      messageOf(accountErrorResponse(new E_ACCOUNT_KIT_DELIVERY(), { i18n })!),
      "L'opération a échoué"
    )
    assert.equal(
      messageOf(accountErrorResponse(new E_ACCOUNT_KIT_AUTHORIZATION(), { i18n })!),
      'Access denied.'
    )
    assert.notInclude(lookups, 'errors.E_ACCOUNT_KIT_INVITATION_MANAGEMENT_DENIED')
    assert.include(lookups, 'errors.E_ACCOUNT_KIT_FORBIDDEN')
    assert.equal(
      messageOf(accountErrorResponse(new E_ACCOUNT_KIT_DELIVERY())!),
      'Account operation failed.'
    )
  })

  test('the helper and the managed renderer produce the same entry for every package error', ({
    assert,
  }) => {
    for (const ErrorClass of Object.values(errors)) {
      if (
        ErrorClass !== errors.E_ACCOUNT_KIT &&
        !(ErrorClass.prototype instanceof errors.E_ACCOUNT_KIT)
      )
        continue
      const error =
        ErrorClass === errors.E_ACCOUNT_KIT_THROTTLED
          ? new errors.E_ACCOUNT_KIT_THROTTLED(1)
          : new (ErrorClass as new () => Error)()
      const helper = accountErrorResponse(error)!
      const managed = mapManagedErrorResponse(error)!
      assert.deepEqual(helper, managed, ErrorClass.name)
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
        ErrorClass !== errors.E_ACCOUNT_KIT &&
        !(ErrorClass.prototype instanceof errors.E_ACCOUNT_KIT)
      )
        continue
      const error =
        ErrorClass === errors.E_ACCOUNT_KIT_THROTTLED
          ? new errors.E_ACCOUNT_KIT_THROTTLED(1)
          : new (ErrorClass as new () => Error)()
      const response = accountErrorResponse(error)!
      actual[response.body.errors[0].code] = messageOf(response)
    }
    assert.deepEqual(documented, actual)
  })

  test('negotiates JSON:API from accept and sends Vary like the managed routes', ({ assert }) => {
    const response = accountErrorResponse(new E_ACCOUNT_KIT_AUTHORIZATION(), {
      accept: 'application/vnd.api+json',
    })!
    assert.equal(response.contentType, 'application/vnd.api+json')
    assert.deepEqual(response.body.errors, [
      { code: 'E_ACCOUNT_KIT_FORBIDDEN', title: 'Access denied.' },
    ])
    assert.notProperty(response.body.errors[0], 'message')
    assert.equal(response.headers['Vary'], 'Accept')
    assert.equal(
      accountErrorResponse(new E_ACCOUNT_KIT_AUTHORIZATION())!.contentType,
      'application/json'
    )
  })

  test('returns the per-kind invalid-token code when given proof', ({ assert }) => {
    const response = accountErrorResponse(new E_ACCOUNT_KIT_INVALID_TOKEN(), { proof: 'password' })!
    assert.equal(response.status, 400)
    assert.equal(response.body.errors[0].code, 'E_ACCOUNT_KIT_INVALID_PASSWORD_TOKEN')
    assert.equal(
      accountErrorResponse(new E_ACCOUNT_KIT_INVALID_TOKEN())!.body.errors[0].code,
      'E_ACCOUNT_KIT_INVALID_TOKEN'
    )
  })

  test('keeps field for a duplicate registration email', ({ assert }) => {
    const duplicate = new E_ACCOUNT_KIT_REGISTRATION_EMAIL_ALREADY_REGISTERED()
    assert.instanceOf(duplicate, E_ACCOUNT_KIT_EMAIL_ALREADY_REGISTERED)
    assert.equal(duplicate.code, 'E_ACCOUNT_KIT_EMAIL_ALREADY_REGISTERED')
    assert.equal(duplicate.status, 422)
    assert.equal(duplicate.field, 'email')
    const response = accountErrorResponse(duplicate)!
    assert.equal(response.status, 422)
    assert.deepEqual(response.body.errors, [
      {
        code: 'E_ACCOUNT_KIT_EMAIL_ALREADY_REGISTERED',
        message: 'The account request conflicts with an existing account.',
        field: 'email',
      },
    ])
    const jsonApi = accountErrorResponse(
      new E_ACCOUNT_KIT_REGISTRATION_EMAIL_ALREADY_REGISTERED(),
      {
        accept: 'application/vnd.api+json',
      }
    )!
    assert.notProperty(jsonApi.body.errors[0], 'field')
  })

  test('drops field when the public identity masks the error', ({ assert }) => {
    const failed = Object.assign(new E_ACCOUNT_KIT_POST_COMMIT(), { field: 'email' })
    const denied = Object.assign(new E_ACCOUNT_KIT_INVITATION_MANAGEMENT_DENIED(), {
      field: 'email',
    })
    assert.notProperty(accountErrorResponse(failed)!.body.errors[0], 'field')
    assert.notProperty(accountErrorResponse(denied)!.body.errors[0], 'field')
  })
})
