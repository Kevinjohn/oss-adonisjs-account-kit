import { test } from '@japa/runner'
import { isEmailShaped, normaliseEmail } from '../../src/email.js'

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
