import { test } from '@japa/runner'
import { isSqlIdentifier } from '../src/sql_identifier.js'
import { isPasswordShaped, MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from '../src/password.js'

test.group('Shared constants', () => {
  test('isSqlIdentifier accepts plain identifiers and rejects anything else', ({ assert }) => {
    for (const value of ['users', '_users', 'User_2', 'a'])
      assert.isTrue(isSqlIdentifier(value), value)
    for (const value of ['', '2users', 'user-table', 'users;drop', 'a.b', 'a b', 'users\n'])
      assert.isFalse(isSqlIdentifier(value), JSON.stringify(value))
  })

  test('password length bounds are 8 and 256 and drive isPasswordShaped', ({ assert }) => {
    assert.equal(MIN_PASSWORD_LENGTH, 8)
    assert.equal(MAX_PASSWORD_LENGTH, 256)
    assert.isFalse(isPasswordShaped('a'.repeat(MIN_PASSWORD_LENGTH - 1)))
    assert.isTrue(isPasswordShaped('a'.repeat(MIN_PASSWORD_LENGTH)))
    assert.isTrue(isPasswordShaped('a'.repeat(MAX_PASSWORD_LENGTH)))
    assert.isFalse(isPasswordShaped('a'.repeat(MAX_PASSWORD_LENGTH + 1)))
    assert.isFalse(isPasswordShaped(12345678))
  })
})
