import { test } from '@japa/runner'
import { isIdentityConflict } from '../src/social_callback.ts'

test.group('social identity unique-violation detection', () => {
  test('recognizes the exact provider and subject constraint on each driver', ({ assert }) => {
    assert.isTrue(
      isIdentityConflict({
        code: '23505',
        constraint: 'social_identities_provider_provider_user_id_unique',
      })
    )
    assert.isTrue(
      isIdentityConflict({
        code: 'SQLITE_CONSTRAINT_UNIQUE',
        message:
          'UNIQUE constraint failed: social_identities.provider, social_identities.provider_user_id',
      })
    )
    assert.isTrue(
      isIdentityConflict({
        code: 'ER_DUP_ENTRY',
        sqlMessage:
          "Duplicate entry 'subject' for key 'social_identities.social_identities_provider_provider_user_id_unique'",
      })
    )
  })

  test('rejects overlapping constraints, columns and MySQL keys', ({ assert }) => {
    assert.isFalse(
      isIdentityConflict({
        code: '23505',
        constraint: 'social_identities_provider_provider_user_id_unique_extra',
      })
    )
    assert.isFalse(
      isIdentityConflict({
        code: 'SQLITE_CONSTRAINT_UNIQUE',
        message:
          'UNIQUE constraint failed: social_identities.provider, social_identities.provider_user_id, social_identities.tenant_id',
      })
    )
    assert.isFalse(
      isIdentityConflict({
        code: 'ER_DUP_ENTRY',
        sqlMessage:
          "Duplicate entry 'subject' for key 'social_identities.social_identities_provider_provider_user_id_unique_extra'",
      })
    )
  })
})
