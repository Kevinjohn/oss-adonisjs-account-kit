import { test } from '@japa/runner'
import { assertPlainObject } from '../src/config_assert.js'

test.group('config section guard', () => {
  test('accepts objects and rejects other values with one message', ({ assert }) => {
    assert.doesNotThrow(() => assertPlainObject({}, 'urls'))
    for (const value of [null, undefined, [], 'text', 1, true])
      assert.throws(() => assertPlainObject(value, 'urls'), 'account_kit: urls must be an object')
  })
})
