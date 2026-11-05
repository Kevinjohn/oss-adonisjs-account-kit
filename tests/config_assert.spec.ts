import { test } from '@japa/runner'
import { assertObject } from '../src/config_assert.js'

test.group('config section guard', () => {
  test('accepts objects and rejects other values with one message', ({ assert }) => {
    class Section {
      value = 'configured'
    }
    for (const value of [{}, new Section(), Object.create(null)])
      assert.doesNotThrow(() => assertObject(value, 'urls'))
    for (const value of [null, undefined, [], 'text', 1, true])
      assert.throws(() => assertObject(value, 'urls'), 'account_kit: urls must be an object')
  })
})
