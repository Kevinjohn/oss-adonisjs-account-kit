import { sharedFor } from '#tests/helpers/unit_shared_props'
import { test } from '@japa/runner'

test.group('Shared Inertia props', () => {
  test('emailVerified follows the package rule, not emailVerifiedAt', ({ assert }) => {
    // An existing user from before the migration: both columns are null, and the account is active.
    assert.isTrue(
      sharedFor({ email: 'old@example.test', unverifiedEmail: null, emailVerifiedAt: null })
        .emailVerified
    )
    assert.isFalse(
      sharedFor({
        email: 'new@example.test',
        unverifiedEmail: 'new@example.test',
        emailVerifiedAt: null,
      }).emailVerified
    )
  })
})
