import { randomUUID } from 'node:crypto'
import { test } from '@japa/runner'
import { DateTime } from 'luxon'
import db from '@adonisjs/lucid/services/db'
import User from '#models/user'
import { notifications } from '#services/account_kit_notifications'

function cookies(response: { header(name: string): string | string[] | undefined }): string {
  const values = response.header('set-cookie')
  return (Array.isArray(values) ? values : [values])
    .filter(Boolean)
    .map((value) => String(value).split(';', 1)[0])
    .join('; ')
}

function bearerFromLogin(response: { body(): unknown }): string {
  const body = response.body()
  if (typeof body !== 'object' || body === null || !('data' in body)) {
    throw new Error('Login response is missing its data envelope')
  }
  const data = body.data
  if (typeof data !== 'object' || data === null || !('token' in data)) {
    throw new Error('Token login response is missing its token')
  }
  const token = data.token
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error('Token login response contains an invalid token')
  }
  return token
}

test('a recipient can accept after the inviter loses issuance permission', async ({
  client,
  assert,
}) => {
  notifications.reset()
  const suffix = randomUUID()
  const inviter = await User.create({
    fullName: 'Invitation Owner',
    email: `owner-${suffix}@example.test`,
    password: 'OwnerPass123!',
    emailVerifiedAt: DateTime.utc(),
  })
  await db.table('role_assignments').insert({ user_id: inviter.id, role: 'owner' })

  const sessionMode = process.env.ACCOUNT_KIT_AUTH_STRATEGY === 'session'
  let ownerCredential: { bearer?: string; cookie?: string; csrf?: string }
  if (sessionMode) {
    const bootstrap = await client.get('/api/v1/auth/csrf')
    const login = await client
      .post('/api/v1/auth/login')
      .header('cookie', cookies(bootstrap))
      .header('x-csrf-token', (bootstrap.body() as { csrfToken: string }).csrfToken)
      .json({ email: inviter.email, password: 'OwnerPass123!' })
    assert.equal(login.status(), 200, JSON.stringify(login.body()))
    const cookie = cookies(login)
    const csrf = await client.get('/api/v1/auth/csrf').header('cookie', cookie)
    ownerCredential = { cookie, csrf: (csrf.body() as { csrfToken: string }).csrfToken }
  } else {
    const login = await client
      .post('/api/v1/auth/login')
      .json({ email: inviter.email, password: 'OwnerPass123!' })
    assert.equal(login.status(), 200, JSON.stringify(login.body()))
    ownerCredential = {
      bearer: bearerFromLogin(login),
    }
  }

  const send = client.post('/api/v1/account/invitations')
  if (ownerCredential.bearer) send.bearerToken(ownerCredential.bearer)
  else {
    send.header('cookie', ownerCredential.cookie!).header('x-csrf-token', ownerCredential.csrf!)
  }
  const recipient = `member-${suffix}@example.test`
  const issued = await send.json({ email: recipient, role: 'member' })
  assert.equal(issued.status(), 201, JSON.stringify(issued.body()))
  const notice = notifications.events.find(
    (event) => event.kind === 'invitation' && event.recipient === recipient
  )
  assert.isDefined(notice)
  const token = decodeURIComponent(new URL(notice!.value).pathname.split('/').at(-1)!)

  await db.from('role_assignments').where('user_id', inviter.id).delete()
  const deniedSend = client.post('/api/v1/account/invitations')
  if (ownerCredential.bearer) deniedSend.bearerToken(ownerCredential.bearer)
  else {
    deniedSend
      .header('cookie', ownerCredential.cookie!)
      .header('x-csrf-token', ownerCredential.csrf!)
  }
  const denied = await deniedSend.json({
    email: `denied-${suffix}@example.test`,
    role: 'member',
  })
  assert.equal(denied.status(), 403)

  const acceptance = client.post(`/api/v1/auth/invitations/${encodeURIComponent(token)}`)
  if (sessionMode) {
    const acceptanceCsrf = await client.get('/api/v1/auth/csrf')
    acceptance
      .header('cookie', cookies(acceptanceCsrf))
      .header('x-csrf-token', (acceptanceCsrf.body() as { csrfToken: string }).csrfToken)
  }
  const accepted = await acceptance.json({
    fullName: 'Invited Member',
    password: 'MemberPass123!',
    passwordConfirmation: 'MemberPass123!',
  })
  assert.equal(accepted.status(), 201, JSON.stringify(accepted.body()))
  const member = await User.findByOrFail('email', recipient)
  assert.isDefined(
    await db.from('role_assignments').where('user_id', member.id).where('role', 'member').first()
  )
})
