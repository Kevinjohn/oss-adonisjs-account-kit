import { test } from '@japa/runner'
import {
  isSensitivePurpose,
  isSocialBeginIntent,
  isSocialIntent,
  sensitivePurposes,
  socialIntents,
} from '../src/social_enums.js'

const junk = ['', 'Login', 'other', undefined, null, 1, {}, ['login']]

test.group('Social intents and purposes', () => {
  test('intent guard accepts every listed intent and rejects anything else', ({ assert }) => {
    assert.deepEqual([...socialIntents], ['login', 'link', 'reauth', 'confirm'])
    for (const value of socialIntents) assert.isTrue(isSocialIntent(value))
    for (const value of junk) assert.isFalse(isSocialIntent(value))
  })

  test('begin-intent guard is the intent list without confirm', ({ assert }) => {
    for (const value of ['login', 'link', 'reauth']) assert.isTrue(isSocialBeginIntent(value))
    assert.isFalse(isSocialBeginIntent('confirm'))
    for (const value of junk) assert.isFalse(isSocialBeginIntent(value))
  })

  test('purpose guard accepts every listed purpose and rejects anything else', ({ assert }) => {
    assert.deepEqual(
      [...sensitivePurposes],
      [
        'social_link',
        'social_unlink',
        'password_change',
        'email_change',
        'account_export',
        'account_delete',
      ]
    )
    for (const value of sensitivePurposes) assert.isTrue(isSensitivePurpose(value))
    for (const value of [...junk, 'login']) assert.isFalse(isSensitivePurpose(value))
  })
})
