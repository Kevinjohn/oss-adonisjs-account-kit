/* eslint-disable @unicorn/no-await-expression-member -- Keep session lifecycle assertions beside their HTTP requests. */

import { randomUUID } from 'node:crypto'
import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import User from '#models/user'
import { notifications } from '#services/account_kit_notifications'

const proofFrom = (url: string) => decodeURIComponent(new URL(url).pathname.split('/').at(-1)!)

function cookies(response: { header(name: string): string | string[] | undefined }): string {
  const values = response.header('set-cookie')
  return (Array.isArray(values) ? values : [values])
    .filter(Boolean)
    .map((value) => String(value).split(';', 1)[0])
    .join('; ')
}

test('session reference gives the same public login failure for missing, wrong, and restricted accounts', async ({
  client,
  assert,
}) => {
  if (process.env.ACCOUNT_KIT_AUTH_STRATEGY !== 'session') return
  const suffix = randomUUID()
  const allowed = await User.create({
    fullName: 'Allowed Session User',
    email: `allowed-session-${suffix}@example.test`,
    password: 'AllowedPass123!',
  })
  const restricted = await User.create({
    fullName: 'Restricted Session User',
    email: `restricted-session-${suffix}@example.test`,
    password: 'RestrictedPass123!',
  })
  await db.table('role_assignments').insert({ user_id: restricted.id, role: 'disabled' })
  const passwordless = await User.create({
    fullName: 'Passwordless Session User',
    email: `passwordless-session-${suffix}@example.test`,
    password: null,
  })
  const bootstrap = await client.get('/api/v1/auth/csrf')
  const cookie = cookies(bootstrap)
  const token = (bootstrap.body() as { csrfToken: string }).csrfToken
  const attempts = [
    { email: `missing-session-${suffix}@example.test`, password: 'MissingPass123!' },
    { email: allowed.email, password: 'WrongPass123!' },
    { email: restricted.email, password: 'RestrictedPass123!' },
    { email: passwordless.email, password: 'WrongPass123!' },
  ]
  const failures = []
  for (const credentials of attempts) {
    const response = await client
      .post('/api/v1/auth/login')
      .header('cookie', cookie)
      .header('x-csrf-token', token)
      .json(credentials)
    assert.equal(response.status(), 401)
    failures.push(response.body())
    const profile = await client.get('/api/v1/account/profile').header('cookie', cookies(response))
    assert.equal(profile.status(), 401)
  }
  assert.deepEqual(failures[0], failures[1])
  assert.deepEqual(failures[1], failures[2])
  assert.deepEqual(failures[2], failures[3])
  assert.equal(
    (failures[0] as unknown as { errors: [{ code: string }] }).errors[0].code,
    'E_ACCOUNT_KIT_INVALID_CREDENTIALS'
  )
  const success = await client
    .post('/api/v1/auth/login')
    .header('cookie', cookie)
    .header('x-csrf-token', token)
    .json({ email: allowed.email, password: 'AllowedPass123!' })
  assert.equal(success.status(), 200)
  const profile = await client.get('/api/v1/account/profile').header('cookie', cookies(success))
  assert.equal(profile.status(), 200)
})

test('session signup, activation and a new login complete through application-owned HTTP', async ({
  client,
  assert,
}) => {
  if (process.env.ACCOUNT_KIT_AUTH_STRATEGY !== 'session') return
  notifications.reset()
  const email = `session-journey-${randomUUID()}@example.test`
  const csrf = await client.get('/api/v1/auth/csrf')
  const signup = await client
    .post('/api/v1/auth/signup')
    .header('cookie', cookies(csrf))
    .header('x-csrf-token', (csrf.body() as { csrfToken: string }).csrfToken)
    .json({
      fullName: 'Session Journey',
      email,
      password: 'InitialPass123!',
      passwordConfirmation: 'InitialPass123!',
    })
  assert.equal(signup.status(), 200, JSON.stringify(signup.body()))
  const limitedSession = cookies(signup)
  assert.equal(
    (await client.get('/api/v1/account/profile').header('cookie', limitedSession)).status(),
    200
  )
  assert.equal(
    (await client.get('/api/v1/account/invitations').header('cookie', limitedSession)).status(),
    403
  )
  const activationUrl = notifications.events.findLast(
    (event) => event.kind === 'verification' && event.recipient === email
  )?.value
  assert.isString(activationUrl)
  const path = `/api/v1/auth/email-verification/${encodeURIComponent(proofFrom(activationUrl!))}`
  for (let index = 0; index < 2; index++) {
    const inspect = await client.get(path)
    assert.equal(inspect.status(), 200)
    assert.equal(inspect.header('cache-control'), 'no-store')
    assert.equal(inspect.header('referrer-policy'), 'no-referrer')
  }
  const proofCsrf = await client.get('/api/v1/auth/csrf')
  const complete = await client
    .post(path)
    .header('cookie', cookies(proofCsrf))
    .header('x-csrf-token', (proofCsrf.body() as { csrfToken: string }).csrfToken)
    .json({ password: 'ClaimedPass123!', passwordConfirmation: 'ClaimedPass123!' })
  assert.equal(complete.status(), 200, JSON.stringify(complete.body()))
  const user = await User.findByOrFail('email', email)
  assert.isNull(user.unverifiedEmail)
  assert.equal(
    (await client.get('/api/v1/account/profile').header('cookie', limitedSession)).status(),
    401
  )
  const replay = await client
    .post(path)
    .header('cookie', cookies(proofCsrf))
    .header('x-csrf-token', (proofCsrf.body() as { csrfToken: string }).csrfToken)
    .json({ password: 'ClaimedPass123!', passwordConfirmation: 'ClaimedPass123!' })
  assert.equal(replay.status(), 400)
  const oldLoginCsrf = await client.get('/api/v1/auth/csrf')
  const oldLogin = await client
    .post('/api/v1/auth/login')
    .header('cookie', cookies(oldLoginCsrf))
    .header('x-csrf-token', (oldLoginCsrf.body() as { csrfToken: string }).csrfToken)
    .json({ email, password: 'InitialPass123!' })
  assert.equal(oldLogin.status(), 401)
  const newLogin = await client
    .post('/api/v1/auth/login')
    .header('cookie', cookies(oldLoginCsrf))
    .header('x-csrf-token', (oldLoginCsrf.body() as { csrfToken: string }).csrfToken)
    .json({ email, password: 'ClaimedPass123!' })
  assert.equal(newLogin.status(), 200)
  const profile = await client.get('/api/v1/account/profile').header('cookie', cookies(newLogin))
  assert.equal(profile.status(), 200)
  assert.isTrue((profile.body() as unknown as { data: { active: boolean } }).data.active)
})
