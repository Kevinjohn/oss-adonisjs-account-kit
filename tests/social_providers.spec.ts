import { test } from '@japa/runner'
import {
  isSocialProviderName,
  socialProviderLabels,
  socialProviderNames,
} from '../src/social_providers.js'

test.group('Social provider names', () => {
  test('guard accepts every listed provider and rejects anything else', ({ assert }) => {
    for (const name of socialProviderNames) assert.isTrue(isSocialProviderName(name))
    for (const value of ['Google', 'gitlab', '', undefined, null, 1, {}, ['google']])
      assert.isFalse(isSocialProviderName(value))
  })

  test('every provider has a display label', ({ assert }) => {
    assert.deepEqual(Object.keys(socialProviderLabels).sort(), [...socialProviderNames].sort())
    assert.equal(socialProviderLabels.google, 'Google')
    assert.equal(socialProviderLabels.github, 'GitHub')
  })
})
