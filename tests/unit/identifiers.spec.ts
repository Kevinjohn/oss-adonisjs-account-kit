import { test } from '@japa/runner'
import { isSqlIdentifier } from '../../src/identifiers.js'

test.group('identifier helper', () => {
  test('isSqlIdentifier accepts plain identifiers and rejects anything else', ({ assert }) => {
    for (const value of ['users', '_users', 'User_2', 'a'])
      assert.isTrue(isSqlIdentifier(value), value)
    for (const value of ['', '2users', 'user-table', 'users;drop', 'a.b', 'a b', 'users\n'])
      assert.isFalse(isSqlIdentifier(value), JSON.stringify(value))
  })
})
