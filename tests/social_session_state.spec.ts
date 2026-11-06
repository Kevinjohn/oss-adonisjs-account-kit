import { createHash } from 'node:crypto'
import { test } from '@japa/runner'
import type { HttpContext } from '@adonisjs/core/http'
import { SocialTransactionError } from '../src/errors.js'
import {
  forgetSessionState,
  rememberSessionState,
  sessionState,
} from '../src/http/social_session_state.js'

function sessionContext() {
  const store = new Map<string, unknown>()
  const context = {
    session: {
      get: (key: string) => store.get(key),
      put: (key: string, value: unknown) => store.set(key, value),
      forget: (key: string) => store.delete(key),
    },
  } as unknown as HttpContext
  return { context, store }
}

const stateKey = (state: string) =>
  `accountKit.social.${createHash('sha256').update(state).digest('hex')}`
const saved = { verifier: 'v'.repeat(43), intent: 'login' as const, provider: 'google' as const }

test.group('social session state', () => {
  test('returns a remembered state until it is forgotten', ({ assert }) => {
    const { context, store } = sessionContext()
    rememberSessionState(context, 'state-1', saved)
    assert.include(sessionState(context, 'state-1'), saved)
    forgetSessionState(context, 'state-1')
    assert.isFalse(store.has(stateKey('state-1')))
    assert.throws(() => sessionState(context, 'state-1'), SocialTransactionError)
  })

  test('refuses unknown, unlisted, malformed and expired states', ({ assert }) => {
    const { context, store } = sessionContext()
    assert.throws(() => sessionState(context, 'never-issued'), SocialTransactionError)

    // Stored, but missing from the pending list.
    rememberSessionState(context, 'unlisted', saved)
    store.set('accountKit.social.pendingStates', [])
    assert.throws(() => sessionState(context, 'unlisted'), SocialTransactionError)

    // Each value differs from a valid record in one field only.
    const valid = { ...saved, expiresAt: Date.now() + 60_000 }
    rememberSessionState(context, 'control', saved)
    store.set(stateKey('control'), valid)
    assert.deepEqual(sessionState(context, 'control'), valid)
    for (const [index, value] of [
      'not-an-object',
      { ...valid, verifier: 7 },
      { ...valid, intent: undefined },
      { ...valid, provider: 'unknown' },
      { ...valid, expiresAt: 'later' },
    ].entries()) {
      const state = `malformed-${index}`
      rememberSessionState(context, state, saved)
      store.set(stateKey(state), value)
      assert.throws(() => sessionState(context, state), SocialTransactionError)
    }

    // Listed as live, but the stored value has expired.
    rememberSessionState(context, 'expired', { ...saved, expiresAt: Date.now() + 60_000 })
    store.set(stateKey('expired'), { ...saved, expiresAt: Date.now() - 1 })
    assert.throws(() => sessionState(context, 'expired'), SocialTransactionError)

    // Expired in the pending list: the stored value is dropped too.
    rememberSessionState(context, 'lapsed', { ...saved, expiresAt: Date.now() - 1 })
    assert.throws(() => sessionState(context, 'lapsed'), SocialTransactionError)
    assert.isFalse(store.has(stateKey('lapsed')))
  })
})
