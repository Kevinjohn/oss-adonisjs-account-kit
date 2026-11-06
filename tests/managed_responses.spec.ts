import { readFile } from 'node:fs/promises'
import { test } from '@japa/runner'
import * as errors from '../src/errors.js'
import {
  InvalidCredentialsError,
  InvalidInputError,
  IdentityNotConfirmedError,
  InvalidTokenError,
  InvitationManagementDeniedError,
  PostCommitError,
  ThrottledError,
} from '../src/errors.js'
import { managedErrorResponse, proofHeaders } from '../src/http/responses.js'
import { ruleError } from '../src/http/response_helpers.js'
import type { HttpContext } from '@adonisjs/core/http'

test.group('managed HTTP responses', () => {
  test('package 422s follow Accept and are never cached', ({ assert }) => {
    const send = (accept?: string) => {
      const headers: Record<string, string> = {}
      const vary: string[] = []
      let sent: { status?: number; body?: unknown } = {}
      const context = {
        request: { header: () => accept },
        response: {
          header: (name: string, value: string) => void (headers[name] = value),
          vary: (value: string) => void vary.push(value),
          status(status: number) {
            sent.status = status
            return { send: (body: unknown) => (sent = { ...sent, body }) }
          },
        },
      } as unknown as HttpContext
      ruleError(context, 'email', 'unique', 'The email has already been taken.')
      return { headers, vary, ...sent }
    }
    assert.deepEqual(send(), {
      headers: { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' },
      vary: ['Accept'],
      status: 422,
      body: {
        errors: [{ field: 'email', rule: 'unique', message: 'The email has already been taken.' }],
      },
    })
    assert.deepEqual(send('application/vnd.api+json'), {
      headers: { 'Cache-Control': 'no-store', 'Content-Type': 'application/vnd.api+json' },
      vary: ['Accept'],
      status: 422,
      body: {
        errors: [
          {
            code: 'unique',
            title: 'The email has already been taken.',
            source: { pointer: 'email' },
          },
        ],
      },
    })
  })

  test('maps proof failures to one generic code and hides all causes', ({ assert }) => {
    const error = new InvalidTokenError('database row and token details')
    assert.deepEqual(managedErrorResponse(error, { proof: 'password' }), {
      status: 400,
      headers: { 'Vary': 'Accept', 'Cache-Control': 'no-store' },
      contentType: 'application/json',
      body: {
        errors: [
          {
            code: 'E_ACCOUNT_KIT_INVALID_PASSWORD_TOKEN',
            message: 'This link is invalid or expired.',
          },
        ],
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
        headers: { 'Vary': 'Accept', 'Cache-Control': 'no-store', 'Retry-After': '2' },
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
        headers: { 'Vary': 'Accept', 'Cache-Control': 'no-store' },
        contentType: 'application/json',
        body: {
          errors: [{ code: 'E_ACCOUNT_KIT_INVALID_INPUT', message: 'Account request rejected.' }],
        },
      })
    }
  })

  test('negotiates JSON for missing, wildcard and HTML Accept values', ({ assert }) => {
    const error = new InvalidCredentialsError()
    for (const accept of [undefined, '*/*', 'application/*', 'text/html']) {
      assert.equal(managedErrorResponse(error, { accept })?.contentType, 'application/json', accept)
    }
    assert.equal(
      managedErrorResponse(error, { accept: 'application/json;q=0.5, application/vnd.api+json' })
        ?.contentType,
      'application/vnd.api+json'
    )
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
        headers: { 'Vary': 'Accept', 'Cache-Control': 'no-store' },
        contentType: 'application/json',
        body: {
          errors: [
            {
              code: 'E_ACCOUNT_KIT_INVALID_EMAIL_TOKEN',
              message: 'Public E_ACCOUNT_KIT_INVALID_EMAIL_TOKEN',
            },
          ],
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

  test('translates wording as errors.<code> and lets the message hook have the last word', ({
    assert,
  }) => {
    const lookups: unknown[] = []
    const i18n = {
      t(identifier: string, data: Record<string, unknown>, fallbackMessage: string) {
        lookups.push([identifier, data, fallbackMessage])
        return identifier === 'errors.E_ACCOUNT_KIT_THROTTLED'
          ? 'Trop de requêtes.'
          : fallbackMessage
      },
    }
    assert.deepEqual(managedErrorResponse(new ThrottledError(1), { i18n })?.body, {
      errors: [{ code: 'E_ACCOUNT_KIT_THROTTLED', message: 'Trop de requêtes.' }],
    })
    assert.deepEqual(lookups, [['errors.E_ACCOUNT_KIT_THROTTLED', {}, 'Too many requests.']])
    assert.deepEqual(
      managedErrorResponse(new InvalidTokenError(), { proof: 'magicLink', i18n })?.body,
      {
        errors: [
          { code: 'E_ACCOUNT_KIT_INVALID_MAGIC_LINK', message: 'This link is invalid or expired.' },
        ],
      }
    )
    assert.deepEqual(
      managedErrorResponse(new ThrottledError(1), {
        i18n,
        message: (code, defaultMessage) => `${code}: ${defaultMessage}`,
      })?.body,
      {
        errors: [
          {
            code: 'E_ACCOUNT_KIT_THROTTLED',
            message: 'E_ACCOUNT_KIT_THROTTLED: Trop de requêtes.',
          },
        ],
      }
    )
  })

  test('does not expose committed callback failures as a rolled-back response', ({ assert }) => {
    assert.deepEqual(managedErrorResponse(new PostCommitError('mail failed'))?.body, {
      errors: [
        {
          code: 'E_ACCOUNT_KIT_OPERATION_FAILED',
          message: 'Account operation failed.',
          committed: true,
        },
      ],
    })
    assert.deepEqual(proofHeaders(), {
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
    })
  })

  test('distinguishes rejected identity proof from an unverified email', ({ assert }) => {
    assert.deepEqual(managedErrorResponse(new IdentityNotConfirmedError()), {
      status: 403,
      headers: { 'Vary': 'Accept', 'Cache-Control': 'no-store' },
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

  test('hides denied invitation management as a missing invitation', ({ assert }) => {
    assert.deepEqual(managedErrorResponse(new InvitationManagementDeniedError()), {
      status: 404,
      headers: { 'Vary': 'Accept', 'Cache-Control': 'no-store' },
      contentType: 'application/json',
      body: {
        errors: [{ code: 'E_ACCOUNT_KIT_INVITATION_NOT_FOUND', message: 'Invitation not found.' }],
      },
    })
  })
})

test.group('managed HTTP error wording docs', () => {
  test('the documented errors.json lists every managed code with its English message', async ({
    assert,
  }) => {
    const docs = await readFile(new URL('../docs/guide/managed-http.md', import.meta.url), 'utf8')
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
      for (const proof of ['password', 'email', 'invitation', 'magicLink'] as const) {
        const body = managedErrorResponse(error, { proof })?.body.errors[0]
        if (body && 'message' in body) actual[body.code] = body.message
      }
    }
    assert.deepEqual(documented, actual)
  })
})
