import { randomUUID } from 'node:crypto'
import { test } from '@japa/runner'
import app from '@adonisjs/core/services/app'
import { AccountKit } from 'adonisjs-account-kit'
import User from '#models/user'
import { notifications } from '#services/account_kit_notifications'

const tokenFrom = (url: string) => decodeURIComponent(new URL(url).pathname.split('/').at(-1)!)

function rawCookies(response: { header(name: string): string | string[] | undefined }): string {
  const values = response.header('set-cookie')
  return (Array.isArray(values) ? values : [values])
    .filter(Boolean)
    .map((value) => String(value).split(';', 1)[0])
    .join('; ')
}

test('session login needs CSRF, rotates the session, and logout rejects the old cookie', async ({
  client,
  assert,
}) => {
  if (process.env.ACCOUNT_KIT_AUTH_STRATEGY !== 'session') return
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

  const profile = await client.get('/api/v1/account/profile').header('cookie', rawCookies(login))
  assert.equal(profile.status(), 200, JSON.stringify(profile.body()))
  const profileData = (profile.body() as unknown as { data: Record<string, unknown> }).data
  assert.equal(profileData.id, user.id)
  assert.notProperty(profileData, 'password')
  assert.notProperty(profileData, 'credentialsChangedAt')

  const logoutCsrf = await client.get('/api/v1/auth/csrf').header('cookie', rawCookies(login))
  const logout = await client
    .post('/api/v1/account/logout')
    .header('cookie', rawCookies(login))
    .header('x-csrf-token', (logoutCsrf.body() as { csrfToken: string }).csrfToken)
  assert.equal(logout.status(), 200)
  const oldSession = await client.get('/api/v1/account/profile').header('cookie', rawCookies(login))
  assert.equal(oldSession.status(), 401)
  const repeatCsrf = await client.get('/api/v1/auth/csrf').header('cookie', rawCookies(login))
  const repeatedLogout = await client
    .post('/api/v1/account/logout')
    .header('cookie', rawCookies(repeatCsrf))
    .header('x-csrf-token', (repeatCsrf.body() as { csrfToken: string }).csrfToken)
  assert.equal(repeatedLogout.status(), 401)
})

test('password reset rejects pre-existing sessions on an application-owned route', async ({
  client,
  assert,
}) => {
  if (process.env.ACCOUNT_KIT_AUTH_STRATEGY !== 'session') return
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
})

test('inactive session may request activation but cannot use verified routes', async ({
  client,
  assert,
}) => {
  if (process.env.ACCOUNT_KIT_AUTH_STRATEGY !== 'session') return
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
  const protectedResponse = await client
    .get('/api/v1/account/invitations')
    .header('cookie', cookies)
  assert.equal(protectedResponse.status(), 403)
  assert.equal(
    (protectedResponse.body() as unknown as { errors: [{ code: string }] }).errors[0].code,
    'unverified_email'
  )
})

test('inactive session may replace its unconfirmed email through the guarded route', async ({
  client,
  assert,
}) => {
  if (process.env.ACCOUNT_KIT_AUTH_STRATEGY !== 'session') return
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
})

test('signup establishes a limited session for an inactive account', async ({ client, assert }) => {
  if (process.env.ACCOUNT_KIT_AUTH_STRATEGY !== 'session') return
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
    'unverified_email'
  )
})

test('a password change revokes every previously issued browser session', async ({
  client,
  assert,
}) => {
  if (process.env.ACCOUNT_KIT_AUTH_STRATEGY !== 'session') return
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
  for (const cookies of sessions) {
    const profile = await client.get('/api/v1/account/profile').header('cookie', cookies)
    assert.equal(profile.status(), 401)
  }
})

test('a package restriction change revokes an application-owned protected session route', async ({
  client,
  assert,
}) => {
  if (process.env.ACCOUNT_KIT_AUTH_STRATEGY !== 'session') return
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
})
