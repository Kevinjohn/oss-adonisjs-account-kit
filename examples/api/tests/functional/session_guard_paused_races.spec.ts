import { randomUUID } from 'node:crypto'
import { test } from '@japa/runner'
import User from '#models/user'
import { notifications } from '#services/account_kit_notifications'
import { SESSION_ONLY, isSessionStrategy } from '#tests/helpers/strategy'
import { cookies as rawCookies } from '#tests/helpers/cookies'
import { tokenFrom } from '#tests/helpers/link_tokens'
import { truncateDatabase } from '#tests/helpers/database'

function pauseNextSessionLookup(userId: number | string) {
  const original = User.findOrFail
  const lookup = original.bind(User)
  let signalPaused!: () => void
  let signalResume!: () => void
  const paused = new Promise<void>((resolve) => (signalPaused = resolve))
  const resume = new Promise<void>((resolve) => (signalResume = resolve))
  let waiting = true
  Reflect.set(User, 'findOrFail', async (id: number | string) => {
    const found = await lookup(id)
    if (waiting && String(id) === String(userId)) {
      waiting = false
      signalPaused()
      await resume
    }
    return found
  })
  return {
    paused,
    release() {
      Reflect.set(User, 'findOrFail', original)
      signalResume()
    },
  }
}

test.group('Session guard races', (group) => {
  group.each.setup(truncateDatabase)

  test('a committed reset rejects a login paused inside the real session guard', async ({
    client,
    assert,
  }) => {
    notifications.reset()
    const user = await User.create({
      fullName: 'Pending Reset Login',
      email: `pending-reset-${randomUUID()}@example.test`,
      password: 'OriginalPass123!',
    })
    const requestCsrf = await client.get('/api/v1/auth/csrf')
    const requested = await client
      .post('/api/v1/auth/password-reset')
      .header('cookie', rawCookies(requestCsrf))
      .header('x-csrf-token', (requestCsrf.body() as { csrfToken: string }).csrfToken)
      .json({ email: user.email })
    assert.equal(requested.status(), 202)
    const token = tokenFrom(notifications.events.find((event) => event.kind === 'recovery')!.value)
    const loginCsrf = await client.get('/api/v1/auth/csrf')
    const barrier = pauseNextSessionLookup(user.id)
    let pendingLogin
    try {
      pendingLogin = (async () =>
        client
          .post('/api/v1/auth/login')
          .header('cookie', rawCookies(loginCsrf))
          .header('x-csrf-token', (loginCsrf.body() as { csrfToken: string }).csrfToken)
          .json({ email: user.email, password: 'OriginalPass123!' }))()
      await barrier.paused
      const completionCsrf = await client.get('/api/v1/auth/csrf')
      const reset = await client
        .post(`/api/v1/auth/password-reset/${encodeURIComponent(token)}`)
        .header('cookie', rawCookies(completionCsrf))
        .header('x-csrf-token', (completionCsrf.body() as { csrfToken: string }).csrfToken)
        .json({ password: 'ReplacementPass123!', passwordConfirmation: 'ReplacementPass123!' })
      assert.equal(reset.status(), 202, JSON.stringify(reset.body()))
    } finally {
      barrier.release()
    }
    const rejected = await pendingLogin
    assert.equal(rejected.status(), 401, JSON.stringify(rejected.body()))
    const replayCookies = rawCookies(rejected) || rawCookies(loginCsrf)
    const replay = await client.get('/api/v1/account/profile').header('cookie', replayCookies)
    assert.equal(replay.status(), 401)
  }).skip(!isSessionStrategy, SESSION_ONLY)

  test('fresh-password claim rejects a login paused inside the real session guard', async ({
    client,
    assert,
  }) => {
    notifications.reset()
    const email = `pending-claim-${randomUUID()}@example.test`
    const signupCsrf = await client.get('/api/v1/auth/csrf')
    const signup = await client
      .post('/api/v1/auth/signup')
      .header('cookie', rawCookies(signupCsrf))
      .header('x-csrf-token', (signupCsrf.body() as { csrfToken: string }).csrfToken)
      .json({
        fullName: 'Pending Claim Login',
        email,
        password: 'OriginalPass123!',
        passwordConfirmation: 'OriginalPass123!',
      })
    assert.equal(signup.status(), 200, JSON.stringify(signup.body()))
    const user = await User.findByOrFail('email', email)
    const proof = notifications.events.findLast(
      (event) => event.kind === 'verification' && event.recipient === email
    )
    assert.isDefined(proof)
    const loginCsrf = await client.get('/api/v1/auth/csrf')
    const barrier = pauseNextSessionLookup(user.id)
    let pendingLogin
    try {
      pendingLogin = (async () =>
        client
          .post('/api/v1/auth/login')
          .header('cookie', rawCookies(loginCsrf))
          .header('x-csrf-token', (loginCsrf.body() as { csrfToken: string }).csrfToken)
          .json({ email, password: 'OriginalPass123!' }))()
      await barrier.paused
      const completionCsrf = await client.get('/api/v1/auth/csrf')
      const claim = await client
        .post(`/api/v1/auth/email-verification/${encodeURIComponent(tokenFrom(proof!.value))}`)
        .header('cookie', rawCookies(completionCsrf))
        .header('x-csrf-token', (completionCsrf.body() as { csrfToken: string }).csrfToken)
        .json({ password: 'ClaimedPass123!', passwordConfirmation: 'ClaimedPass123!' })
      assert.equal(claim.status(), 200, JSON.stringify(claim.body()))
    } finally {
      barrier.release()
    }
    const rejected = await pendingLogin
    assert.equal(rejected.status(), 401, JSON.stringify(rejected.body()))
    const replayCookies = rawCookies(rejected) || rawCookies(loginCsrf)
    const replay = await client.get('/api/v1/account/profile').header('cookie', replayCookies)
    assert.equal(replay.status(), 401)
  }).skip(!isSessionStrategy, SESSION_ONLY)
})
