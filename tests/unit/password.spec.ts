import { test } from '@japa/runner'
import { isPasswordShaped } from '../../src/password.js'

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
