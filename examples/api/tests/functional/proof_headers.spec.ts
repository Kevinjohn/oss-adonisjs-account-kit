import { test } from '@japa/runner'
import { SESSION_ONLY, isSessionStrategy } from '#tests/helpers/strategy'
import { truncateDatabase } from '#tests/helpers/database'

test.group('Proof headers', (group) => {
  group.each.setup(truncateDatabase)

  test('malformed proof submission still receives private-cache and referrer headers', async ({
    client,
    assert,
  }) => {
    const malformed = await client
      .post('/api/v1/auth/email-verification/malformed-proof')
      .unsafeJson('{"password":')
    assert.equal(malformed.status(), 400)
    assert.equal(malformed.header('cache-control'), 'no-store')
    assert.equal(malformed.header('referrer-policy'), 'no-referrer')
  })

  test('session CSRF rejection on a proof POST retains private response headers', async ({
    client,
    assert,
  }) => {
    const rejected = await client
      .post('/api/v1/auth/password-reset/invalid-proof')
      .header('x-csrf-token', 'invalid')
      .json({ password: 'NewPass123!', passwordConfirmation: 'NewPass123!' })
    assert.equal(rejected.status(), 403)
    assert.equal(rejected.header('cache-control'), 'no-store')
    assert.equal(rejected.header('referrer-policy'), 'no-referrer')
  }).skip(!isSessionStrategy, SESSION_ONLY)
})
