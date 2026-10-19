import { test } from '@japa/runner'
import {
  isPasswordAllowed,
  isPasswordShaped,
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
} from '../../src/password.js'

test.group('password helper', () => {
  test('accepts only strings between 8 and 256 UTF-16 units', async ({ assert }) => {
    assert.equal(MIN_PASSWORD_LENGTH, 8)
    assert.equal(MAX_PASSWORD_LENGTH, 256)
    assert.isTrue(isPasswordShaped('x'.repeat(8)))
    assert.isTrue(isPasswordShaped('x'.repeat(255)))
    assert.isFalse(isPasswordShaped('x'.repeat(7)))
    assert.isTrue(isPasswordShaped('x'.repeat(256)))
    assert.isTrue(isPasswordShaped('😀'.repeat(128)))
    assert.isFalse(isPasswordShaped('x'.repeat(257)))
    assert.isFalse(isPasswordShaped(12345678))
    assert.isFalse(isPasswordShaped(null))
  })

  test('password policy options and bounds are independently enforced', ({ assert }) => {
    const base = {
      minLength: 8,
      maxLength: null,
      letters: false,
      mixedCase: false,
      numbers: false,
      symbols: false,
      minScore: 0 as const,
    }
    assert.isTrue(isPasswordAllowed('a'.repeat(256), base))
    assert.isFalse(isPasswordAllowed('a'.repeat(257), base))
    assert.isFalse(isPasswordAllowed('a'.repeat(7), base))
    assert.isFalse(isPasswordAllowed('a'.repeat(11), { ...base, minLength: 12 }))
    assert.isFalse(isPasswordAllowed('a'.repeat(17), { ...base, maxLength: 16 }))
    assert.isFalse(isPasswordAllowed('12345678', { ...base, letters: true }))
    assert.isFalse(isPasswordAllowed('lowercase1', { ...base, mixedCase: true }))
    assert.isFalse(isPasswordAllowed('LettersOnly', { ...base, numbers: true }))
    assert.isFalse(isPasswordAllowed('Letters123', { ...base, symbols: true }))
    assert.isTrue(
      isPasswordAllowed('Lowercase1!', {
        ...base,
        letters: true,
        mixedCase: true,
        numbers: true,
        symbols: true,
      })
    )
    assert.isTrue(
      isPasswordAllowed('longlowercasepassphrasewithmanyletters', { ...base, minScore: 3 })
    )
    assert.isTrue(isPasswordAllowed('Password1!', { ...base, minScore: 2 }))
    assert.isFalse(isPasswordAllowed('Password1!', { ...base, minScore: 3 }))
    assert.isFalse(isPasswordAllowed('Ab1!Ab1!', { ...base, minScore: 3 }))
  })
})
