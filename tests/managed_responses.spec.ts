import { test } from '@japa/runner'
import {
  InvalidCredentialsError,
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
      headers: {},
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
        headers: { 'Retry-After': '2' },
        body: { errors: [{ code: 'E_ACCOUNT_KIT_THROTTLED', title: 'Too many requests.' }] },
      }
    )
  })

  test('does not expose committed callback failures as a rolled-back response', ({ assert }) => {
    assert.isNull(managedErrorResponse(new PostCommitError('mail failed')))
    assert.deepEqual(proofHeaders(), {
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
    })
  })
})
