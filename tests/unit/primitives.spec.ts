import { DateTime } from 'luxon'
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
import { isEmailShaped, normaliseEmail } from '../../src/email.js'
import { isPasswordShaped } from '../../src/password.js'
import { toInvitation } from '../../src/rows.js'
import { expiresAt } from '../../src/ttl.js'
import { generateToken, hashToken, isTokenShaped } from '../../src/tokens.js'

test.group('tokens', () => {
  test('generates distinct 32-byte base64url tokens and hashes them as stable SHA-256 hex', async ({
    assert,
  }) => {
    const token = generateToken()
    const another = generateToken()
    assert.equal(Buffer.from(token, 'base64url').length, 32)
    assert.match(token, /^[A-Za-z0-9_-]{43}$/)
    assert.notEqual(token, another)
    assert.match(hashToken(token), /^[a-f0-9]{64}$/)
    assert.equal(hashToken(token), hashToken(token))
  })

  test('accepts only tokens with the required base64url length and charset', async ({ assert }) => {
    assert.isTrue(isTokenShaped('a'.repeat(43)))
    assert.isFalse(isTokenShaped('a'.repeat(42)))
    assert.isFalse(isTokenShaped('a'.repeat(44)))
    assert.isFalse(isTokenShaped(`${'a'.repeat(42)}+`))
    assert.isFalse(isTokenShaped(null))
  })
})

test.group('email helpers', () => {
  test('trims and lowercases addresses', async ({ assert }) => {
    assert.equal(normaliseEmail('  Person@Example.TEST  '), 'person@example.test')
  })

  test('normalizes before checking email length and address shape', async ({ assert }) => {
    assert.isTrue(isEmailShaped('a@b'))
    assert.isTrue(isEmailShaped(`${'a'.repeat(252)}@x`))
    assert.isTrue(isEmailShaped(`  ${'a'.repeat(252)}@x  `))
    assert.isFalse(isEmailShaped('a@'))
    assert.isFalse(isEmailShaped(`${'a'.repeat(253)}@x`))
    assert.isFalse(isEmailShaped('a@@b'))
    assert.isFalse(isEmailShaped('@ab'))
    assert.isFalse(isEmailShaped('ab@'))
    assert.isFalse(isEmailShaped('  @  '))
    assert.isFalse(isEmailShaped('a b@example.test'))
    assert.isFalse(isEmailShaped('a@exa mple.test'))
    assert.isFalse(isEmailShaped(`${' '.repeat(513)}a@b`))
    assert.isFalse(isEmailShaped(null))
  })
})

test.group('password helper', () => {
  test('accepts only strings between 8 and 256 UTF-16 units', async ({ assert }) => {
    assert.isTrue(isPasswordShaped('x'.repeat(8)))
    assert.isTrue(isPasswordShaped('x'.repeat(255)))
    assert.isFalse(isPasswordShaped('x'.repeat(7)))
    assert.isTrue(isPasswordShaped('x'.repeat(256)))
    assert.isTrue(isPasswordShaped('😀'.repeat(128)))
    assert.isFalse(isPasswordShaped('x'.repeat(257)))
    assert.isFalse(isPasswordShaped(12345678))
    assert.isFalse(isPasswordShaped(null))
  })
})

test.group('expiration helper', () => {
  test('adds parsed TTL seconds to a DateTime', async ({ assert }) => {
    const now = DateTime.utc(2026, 1, 2, 3, 4, 5)
    assert.equal(expiresAt(now, '1h').toMillis(), now.plus({ hours: 1 }).toMillis())
    assert.equal(expiresAt(now, '7d').toMillis(), now.plus({ days: 7 }).toMillis())
    assert.equal(expiresAt(now, 3600).toMillis(), expiresAt(now, '1h').toMillis())
    assert.equal(expiresAt(now, 1.5).toMillis(), now.plus({ seconds: 1.5 }).toMillis())
  })

  test('rejects non-positive and unparseable TTL values', async ({ assert }) => {
    const now = DateTime.utc()
    assert.throws(() => expiresAt(now, '0s'))
    assert.throws(() => expiresAt(now, 'soon'))
    assert.throws(() => expiresAt(now, '100000000000000000000d'))
    for (const seconds of [
      0,
      -1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      assert.throws(() => expiresAt(now, seconds))
    }
  })
})

test.group('database row mapping', () => {
  test('maps an invitation and omits its private token hash', async ({ assert }) => {
    const expiration = new Date('2026-05-06T07:08:09.000Z')
    const createdAt = new Date('2026-05-01T00:00:00.000Z')
    const updatedAt = new Date('2026-05-02T00:00:00.000Z')
    const invitation = toInvitation({
      id: 3,
      email: 'person@example.test',
      role: 'editor',
      inviter_id: 12,
      token_hash: 'private-hash',
      expires_at: expiration,
      created_at: createdAt,
      updated_at: updatedAt,
    })
    assert.deepEqual(invitation, {
      id: 3,
      email: 'person@example.test',
      role: 'editor',
      inviterId: 12,
      expiresAt: DateTime.fromJSDate(expiration, { zone: 'utc' }),
      createdAt: DateTime.fromJSDate(createdAt, { zone: 'utc' }),
      updatedAt: DateTime.fromJSDate(updatedAt, { zone: 'utc' }),
    })
    assert.notProperty(invitation, 'token_hash')
  })
})

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
