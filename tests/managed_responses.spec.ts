import { test } from '@japa/runner'
import {
  InvalidCredentialsError,
  InvalidInputError,
  IdentityNotConfirmedError,
  InvalidTokenError,
  PostCommitError,
  ThrottledError,
} from '../src/errors.js'
import { managedErrorResponse, proofHeaders } from '../src/http/responses.js'

test.group('managed HTTP responses', () => {
  test('maps proof failures to one generic code and hides all causes', ({ assert }) => {
    const error = new InvalidTokenError('database row and token details')
    assert.deepEqual(managedErrorResponse(error, { proof: 'password' }), {
      status: 400,
      headers: { Vary: 'Accept' },
      contentType: 'application/json',
      body: {
        errors: [{ code: 'E_INVALID_PASSWORD_TOKEN', message: 'This link is invalid or expired.' }],
      },
    })
    assert.deepEqual(
      managedErrorResponse(new InvalidTokenError('different cause'), { proof: 'password' }),
      managedErrorResponse(error, { proof: 'password' })
    )
  })

  test('maps authentication and rate limits to stable statuses and JSON:API shape', ({
    assert,
  }) => {
    assert.equal(managedErrorResponse(new InvalidCredentialsError())?.status, 401)
    assert.deepEqual(
      managedErrorResponse(new ThrottledError(1.2), { accept: 'application/vnd.api+json' }),
      {
        status: 429,
        headers: { 'Vary': 'Accept', 'Retry-After': '2' },
        contentType: 'application/vnd.api+json',
        body: { errors: [{ code: 'E_ACCOUNT_KIT_THROTTLED', title: 'Too many requests.' }] },
      }
    )
  })

  test('maps configured field-policy failures to safe 422 responses', ({ assert }) => {
    for (const detail of [
      'registrationData.fullName is required',
      'registrationData.fullName must be string',
      'registrationData.password is not allowed',
    ]) {
      assert.deepEqual(managedErrorResponse(new InvalidInputError(detail)), {
        status: 422,
        headers: { Vary: 'Accept' },
        contentType: 'application/json',
        body: {
          errors: [{ code: 'E_ACCOUNT_KIT_INVALID_INPUT', message: 'Account request rejected.' }],
        },
      })
    }
  })

  test('honors quality zero and customizes wording without changing a code', ({ assert }) => {
    const error = new InvalidTokenError()
    assert.deepEqual(
      managedErrorResponse(error, {
        proof: 'email',
        accept: 'application/vnd.api+json;q=0, application/json;q=1',
        message: (code) => `Public ${code}`,
      }),
      {
        status: 400,
        headers: { Vary: 'Accept' },
        contentType: 'application/json',
        body: {
          errors: [{ code: 'E_INVALID_EMAIL_TOKEN', message: 'Public E_INVALID_EMAIL_TOKEN' }],
        },
      }
    )
    assert.equal(
      managedErrorResponse(error, {
        proof: 'email',
        accept: 'application/*;q=1, application/vnd.api+json;q=0.5',
      })?.contentType,
      'application/json'
    )
    assert.equal(
      managedErrorResponse(error, {
        proof: 'email',
        accept: 'application/*;q=1, application/vnd.api+json;q=0',
      })?.contentType,
      'application/json'
    )
  })

  test('does not expose committed callback failures as a rolled-back response', ({ assert }) => {
    assert.isNull(managedErrorResponse(new PostCommitError('mail failed')))
    assert.deepEqual(proofHeaders(), {
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
    })
  })

  test('distinguishes rejected identity proof from an unverified email', ({ assert }) => {
    assert.deepEqual(managedErrorResponse(new IdentityNotConfirmedError()), {
      status: 403,
      headers: { Vary: 'Accept' },
      contentType: 'application/json',
      body: {
        errors: [
          {
            code: 'E_ACCOUNT_KIT_IDENTITY_NOT_CONFIRMED',
            message: 'Current identity proof could not be confirmed.',
          },
        ],
      },
    })
  })
})
