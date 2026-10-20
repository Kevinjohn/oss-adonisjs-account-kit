import { randomUUID } from 'node:crypto'
import { test } from '@japa/runner'
import app from '@adonisjs/core/services/app'
import { AccountKit } from 'adonisjs-account-kit'
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

  test('session login needs CSRF, rotates the session, and logout rejects the old cookie', async ({
    client,
    assert,
  }) => {
    const user = await User.create({
      fullName: 'Session User',
      email: `session-user-${randomUUID()}@example.test`,
      password: 'SessionPass123!',
    })
    const bootstrap = await client.get('/api/v1/auth/csrf')
    assert.equal(bootstrap.status(), 200, JSON.stringify(bootstrap.body()))
    assert.equal(bootstrap.header('cache-control'), 'no-store')
    const csrf = (bootstrap.body() as { csrfToken: string }).csrfToken
    assert.isString(csrf)
    const beforeCookie = bootstrap.cookie('adonis-session')
    assert.isDefined(beforeCookie)
    assert.isTrue(beforeCookie!.httpOnly)

    const denied = await client
      .post('/api/v1/auth/login')
      .redirects(0)
      .header('cookie', rawCookies(bootstrap))
      .header('x-csrf-token', 'invalid')
      .json({
        email: user.email,
        password: 'SessionPass123!',
      })
    assert.equal(denied.status(), 403)
    assert.equal(
      (denied.body() as unknown as { errors: [{ code: string }] }).errors[0].code,
      'E_BAD_CSRF_TOKEN'
    )

    const login = await client
      .post('/api/v1/auth/login')
      .header('cookie', rawCookies(bootstrap))
      .header('x-csrf-token', csrf)
      .json({ email: user.email, password: 'SessionPass123!' })
    assert.equal(login.status(), 200)
    const afterCookie = login.cookie('adonis-session')
    assert.isDefined(afterCookie)
    assert.notEqual(afterCookie!.value, beforeCookie!.value)
    assert.isTrue(afterCookie!.httpOnly)
    assert.notProperty((login.body() as unknown as { data: Record<string, unknown> }).data, 'token')
    assert.deepEqual(
      Object.keys((login.body() as unknown as { data: { user: object } }).data.user).sort(),
      ['createdAt', 'email', 'fullName', 'id', 'initials', 'updatedAt']
    )

    const profile = await client.get('/api/v1/account/profile').header('cookie', rawCookies(login))
    assert.equal(profile.status(), 200, JSON.stringify(profile.body()))
    const profileData = (profile.body() as unknown as { data: Record<string, unknown> }).data
    assert.equal(profileData.id, user.id)
    assert.notProperty(profileData, 'password')
    assert.notProperty(profileData, 'credentialsChangedAt')

    const otherBootstrap = await client.get('/api/v1/auth/csrf')
    const otherLogin = await client
      .post('/api/v1/auth/login')
      .header('cookie', rawCookies(otherBootstrap))
      .header('x-csrf-token', (otherBootstrap.body() as { csrfToken: string }).csrfToken)
      .json({ email: user.email, password: 'SessionPass123!' })
    assert.equal(otherLogin.status(), 200)
    const otherSession = rawCookies(otherLogin)
    assert.notEqual(otherSession, rawCookies(login))

    const logoutCsrf = await client.get('/api/v1/auth/csrf').header('cookie', rawCookies(login))
    const logout = await client
      .post('/api/v1/account/logout')
      .header('cookie', rawCookies(login))
      .header('x-csrf-token', (logoutCsrf.body() as { csrfToken: string }).csrfToken)
    assert.equal(logout.status(), 200)
    const oldSession = await client
      .get('/api/v1/account/profile')
      .header('cookie', rawCookies(login))
    assert.equal(oldSession.status(), 401)
    const survivingSession = await client
      .get('/api/v1/account/profile')
      .header('cookie', otherSession)
    assert.equal(survivingSession.status(), 200)
    assert.equal((survivingSession.body() as unknown as { data: { id: number } }).data.id, user.id)
    const repeatCsrf = await client.get('/api/v1/auth/csrf').header('cookie', rawCookies(login))
    const repeatedLogout = await client
      .post('/api/v1/account/logout')
      .header('cookie', rawCookies(repeatCsrf))
      .header('x-csrf-token', (repeatCsrf.body() as { csrfToken: string }).csrfToken)
    assert.equal(repeatedLogout.status(), 401)
  }).skip(!isSessionStrategy, SESSION_ONLY)

  test('password reset rejects pre-existing sessions on an application-owned route', async ({
    client,
    assert,
  }) => {
    notifications.reset()
    const user = await User.create({
      fullName: 'Reset Session User',
      email: `reset-session-${randomUUID()}@example.test`,
      password: 'OriginalPass123!',
    })
    const sessions: string[] = []
    for (let index = 0; index < 2; index++) {
      const csrf = await client.get('/api/v1/auth/csrf')
      const login = await client
        .post('/api/v1/auth/login')
        .header('cookie', rawCookies(csrf))
        .header('x-csrf-token', (csrf.body() as { csrfToken: string }).csrfToken)
        .json({ email: user.email, password: 'OriginalPass123!' })
      assert.equal(login.status(), 200)
      sessions.push(rawCookies(login))
    }
    const resetCsrf = await client.get('/api/v1/auth/csrf')
    const requested = await client
      .post('/api/v1/auth/password-reset')
      .header('cookie', rawCookies(resetCsrf))
      .header('x-csrf-token', (resetCsrf.body() as { csrfToken: string }).csrfToken)
      .json({ email: user.email })
    assert.equal(requested.status(), 202)
    const unknown = await client
      .post('/api/v1/auth/password-reset')
      .header('cookie', rawCookies(resetCsrf))
      .header('x-csrf-token', (resetCsrf.body() as { csrfToken: string }).csrfToken)
      .json({ email: `unknown-${randomUUID()}@example.test` })
    assert.equal(unknown.status(), 202)
    assert.deepEqual(unknown.body(), requested.body())
    const token = tokenFrom(notifications.events.find((event) => event.kind === 'recovery')!.value)
    const proofPath = `/api/v1/auth/password-reset/${encodeURIComponent(token)}`
    for (let index = 0; index < 2; index++) {
      const inspect = await client.get(proofPath)
      assert.equal(inspect.status(), 200)
      assert.equal(inspect.header('cache-control'), 'no-store')
      assert.equal(inspect.header('referrer-policy'), 'no-referrer')
    }
    const rejectedProof = await client
      .post(proofPath)
      .header('cookie', rawCookies(resetCsrf))
      .header('x-csrf-token', 'invalid')
      .json({ password: 'ReplacementPass123!', passwordConfirmation: 'ReplacementPass123!' })
    assert.equal(rejectedProof.status(), 403)
    assert.equal(rejectedProof.header('cache-control'), 'no-store')
    assert.equal(rejectedProof.header('referrer-policy'), 'no-referrer')
    assert.equal(
      (rejectedProof.body() as unknown as { errors: [{ code: string }] }).errors[0].code,
      'E_BAD_CSRF_TOKEN'
    )
    const reset = await client
      .post(proofPath)
      .header('cookie', rawCookies(resetCsrf))
      .header('x-csrf-token', (resetCsrf.body() as { csrfToken: string }).csrfToken)
      .json({ password: 'ReplacementPass123!', passwordConfirmation: 'ReplacementPass123!' })
    assert.equal(reset.status(), 202, JSON.stringify(reset.body()))
    const replay = await client
      .post(proofPath)
      .header('cookie', rawCookies(resetCsrf))
      .header('x-csrf-token', (resetCsrf.body() as { csrfToken: string }).csrfToken)
      .json({ password: 'ReplacementPass123!', passwordConfirmation: 'ReplacementPass123!' })
    assert.equal(replay.status(), 400)
    for (const cookies of sessions) {
      const profile = await client.get('/api/v1/account/profile').header('cookie', cookies)
      assert.equal(profile.status(), 401)
    }
    const newCsrf = await client.get('/api/v1/auth/csrf')
    const freshLogin = await client
      .post('/api/v1/auth/login')
      .header('cookie', rawCookies(newCsrf))
      .header('x-csrf-token', (newCsrf.body() as { csrfToken: string }).csrfToken)
      .json({ email: user.email, password: 'ReplacementPass123!' })
    assert.equal(freshLogin.status(), 200)
  }).skip(!isSessionStrategy, SESSION_ONLY)

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

  test('inactive session may request activation but cannot use verified routes', async ({
    client,
    assert,
  }) => {
    const user = await User.create({
      fullName: 'Inactive Session User',
      email: `inactive-session-${randomUUID()}@example.test`,
      password: 'SessionPass123!',
    })
    user.unverifiedEmail = user.email
    await user.save()
    const bootstrap = await client.get('/api/v1/auth/csrf')
    const login = await client
      .post('/api/v1/auth/login')
      .header('cookie', rawCookies(bootstrap))
      .header('x-csrf-token', (bootstrap.body() as { csrfToken: string }).csrfToken)
      .json({ email: user.email, password: 'SessionPass123!' })
    assert.equal(login.status(), 200)
    const cookies = rawCookies(login)
    const profile = await client.get('/api/v1/account/profile').header('cookie', cookies)
    assert.equal(profile.status(), 200, JSON.stringify(profile.body()))
    assert.isFalse((profile.body() as unknown as { data: { active: boolean } }).data.active)
    const sendCsrf = await client.get('/api/v1/auth/csrf').header('cookie', cookies)
    const activation = await client
      .post('/api/v1/account/email-verification/send')
      .header('cookie', cookies)
      .header('x-csrf-token', (sendCsrf.body() as { csrfToken: string }).csrfToken)
      .json({})
    assert.equal(activation.status(), 200)
    const protectedResponse = await client
      .get('/api/v1/account/invitations')
      .header('cookie', cookies)
    assert.equal(protectedResponse.status(), 403)
    assert.equal(
      (protectedResponse.body() as unknown as { errors: [{ code: string }] }).errors[0].code,
      'E_ACCOUNT_KIT_UNVERIFIED_EMAIL'
    )
  }).skip(!isSessionStrategy, SESSION_ONLY)

  test('inactive session may replace its unconfirmed email through the guarded route', async ({
    client,
    assert,
  }) => {
    const user = await User.create({
      fullName: 'Email Correction User',
      email: `email-correction-${randomUUID()}@example.test`,
      password: 'OriginalPass123!',
    })
    user.unverifiedEmail = user.email
    await user.save()
    const bootstrap = await client.get('/api/v1/auth/csrf')
    const login = await client
      .post('/api/v1/auth/login')
      .header('cookie', rawCookies(bootstrap))
      .header('x-csrf-token', (bootstrap.body() as { csrfToken: string }).csrfToken)
      .json({ email: user.email, password: 'OriginalPass123!' })
    assert.equal(login.status(), 200)
    const csrf = await client.get('/api/v1/auth/csrf').header('cookie', rawCookies(login))
    const correction = await client
      .patch('/api/v1/account/profile')
      .header('cookie', rawCookies(login))
      .header('x-csrf-token', (csrf.body() as { csrfToken: string }).csrfToken)
      .json({
        currentPassword: 'OriginalPass123!',
        email: `corrected-${randomUUID()}@example.test`,
      })
    assert.equal(correction.status(), 200, JSON.stringify(correction.body()))
    const staleProfile = await client
      .get('/api/v1/account/profile')
      .header('cookie', rawCookies(login))
    assert.equal(staleProfile.status(), 401)
  }).skip(!isSessionStrategy, SESSION_ONLY)

  test('signup establishes a limited session for an inactive account', async ({
    client,
    assert,
  }) => {
    const bootstrap = await client.get('/api/v1/auth/csrf')
    const email = `signup-session-${randomUUID()}@example.test`
    const signupInput = {
      fullName: 'Session Signup',
      email,
      password: 'NewSessionPass123!',
      passwordConfirmation: 'NewSessionPass123!',
    }
    const rejected = await client
      .post('/api/v1/auth/signup')
      .header('cookie', rawCookies(bootstrap))
      .header('x-csrf-token', 'invalid')
      .json(signupInput)
    assert.equal(rejected.status(), 403)
    assert.isNull(await User.findBy('email', email))
    const signup = await client
      .post('/api/v1/auth/signup')
      .header('cookie', rawCookies(bootstrap))
      .header('x-csrf-token', (bootstrap.body() as { csrfToken: string }).csrfToken)
      .json(signupInput)
    assert.equal(signup.status(), 200, JSON.stringify(signup.body()))
    const cookies = rawCookies(signup)
    assert.isNotEmpty(cookies)
    assert.notProperty((signup.body() as { data: Record<string, unknown> }).data, 'token')
    const protectedResponse = await client
      .get('/api/v1/account/invitations')
      .header('cookie', cookies)
    assert.equal(protectedResponse.status(), 403)
    assert.equal(
      (protectedResponse.body() as unknown as { errors: [{ code: string }] }).errors[0].code,
      'E_ACCOUNT_KIT_UNVERIFIED_EMAIL'
    )
  }).skip(!isSessionStrategy, SESSION_ONLY)

  test('a password change keeps the calling browser session and revokes the others', async ({
    client,
    assert,
  }) => {
    const user = await User.create({
      fullName: 'Revision Session User',
      email: `revision-session-${randomUUID()}@example.test`,
      password: 'OriginalPass123!',
    })
    const sessions: string[] = []
    for (let index = 0; index < 2; index++) {
      const csrf = await client.get('/api/v1/auth/csrf')
      const login = await client
        .post('/api/v1/auth/login')
        .header('cookie', rawCookies(csrf))
        .header('x-csrf-token', (csrf.body() as { csrfToken: string }).csrfToken)
        .json({ email: user.email, password: 'OriginalPass123!' })
      assert.equal(login.status(), 200)
      sessions.push(rawCookies(login))
    }
    for (const cookies of sessions) {
      const profile = await client.get('/api/v1/account/profile').header('cookie', cookies)
      assert.equal(profile.status(), 200)
    }
    const csrf = await client.get('/api/v1/auth/csrf').header('cookie', sessions[0])
    const change = await client
      .post('/api/v1/account/password')
      .header('cookie', sessions[0])
      .header('x-csrf-token', (csrf.body() as { csrfToken: string }).csrfToken)
      .json({
        currentPassword: 'OriginalPass123!',
        newPassword: 'ReplacementPass123!',
        newPasswordConfirmation: 'ReplacementPass123!',
      })
    assert.equal(change.status(), 200, JSON.stringify(change.body()))
    const kept = await client
      .get('/api/v1/account/profile')
      .header('cookie', rawCookies(change) || sessions[0])
    assert.equal(kept.status(), 200)
    const other = await client.get('/api/v1/account/profile').header('cookie', sessions[1])
    assert.equal(other.status(), 401)
  }).skip(!isSessionStrategy, SESSION_ONLY)

  test('a package restriction change revokes an application-owned protected session route', async ({
    client,
    assert,
  }) => {
    const user = await User.create({
      fullName: 'Restricted Session User',
      email: `restricted-session-${randomUUID()}@example.test`,
      password: 'OriginalPass123!',
    })
    const csrf = await client.get('/api/v1/auth/csrf')
    const login = await client
      .post('/api/v1/auth/login')
      .header('cookie', rawCookies(csrf))
      .header('x-csrf-token', (csrf.body() as { csrfToken: string }).csrfToken)
      .json({ email: user.email, password: 'OriginalPass123!' })
    assert.equal(login.status(), 200)
    const cookies = rawCookies(login)
    const before = await client.get('/api/v1/account/profile').header('cookie', cookies)
    assert.equal(before.status(), 200)
    const kit = await app.container.make(AccountKit)
    await kit.authentication.changeRestriction({
      userId: user.id,
      change: async (_account, trx) => {
        await trx.table('role_assignments').insert({ user_id: user.id, role: 'disabled' })
      },
    })
    const after = await client.get('/api/v1/account/profile').header('cookie', cookies)
    assert.equal(after.status(), 401)
  }).skip(!isSessionStrategy, SESSION_ONLY)
})
