import { randomUUID } from 'node:crypto'
import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import User from '#models/user'

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
  const bootstrap = await client.get('/api/v1/auth/csrf')
  const cookie = cookies(bootstrap)
  const token = (bootstrap.body() as { csrfToken: string }).csrfToken
  const attempts = [
    { email: `missing-session-${suffix}@example.test`, password: 'MissingPass123!' },
    { email: allowed.email, password: 'WrongPass123!' },
    { email: restricted.email, password: 'RestrictedPass123!' },
  ]
  const failures = []
  for (const credentials of attempts) {
    const response = await client
      .post('/api/v1/auth/login')
      .header('cookie', cookie)
      .header('x-csrf-token', token)
      .json(credentials)
    assert.equal(response.status(), 400)
    failures.push(response.body())
    const profile = await client.get('/api/v1/account/profile').header('cookie', cookies(response))
    assert.equal(profile.status(), 401)
  }
  assert.deepEqual(failures[0], failures[1])
  assert.deepEqual(failures[1], failures[2])
  const success = await client
    .post('/api/v1/auth/login')
    .header('cookie', cookie)
    .header('x-csrf-token', token)
    .json({ email: allowed.email, password: 'AllowedPass123!' })
  assert.equal(success.status(), 200)
  const profile = await client.get('/api/v1/account/profile').header('cookie', cookies(success))
  assert.equal(profile.status(), 200)
})
