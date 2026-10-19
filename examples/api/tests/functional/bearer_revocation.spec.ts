import { randomUUID } from 'node:crypto'
import { test } from '@japa/runner'
import limiter from '@adonisjs/limiter/services/main'
import db from '@adonisjs/lucid/services/db'
import app from '@adonisjs/core/services/app'
import { AccountKit } from 'adonisjs-account-kit'
import { notifications } from '#services/account_kit_notifications'
import User from '#models/user'
import AuthMiddleware from '#middleware/auth_middleware'
import { ACCESS_TOKENS_ONLY, isSessionStrategy } from '#tests/helpers/strategy'

const responseBody = <T>(response: { body(): unknown }) => response.body() as T

test('a bearer token without the invitation ability cannot send an invitation', async ({
  client,
  assert,
}) => {
  const user = await User.create({
    fullName: 'Limited Token User',
    email: `limited-token-${randomUUID()}@example.test`,
    password: 'OriginalPass123!',
  })
  const token = await User.accessTokens.create(user, ['profile:read'], { expiresIn: '1d' })
  const response = await client
    .post('/api/v1/account/invitations')
    .bearerToken(token.value!.release())
    .json({ email: `invitee-${randomUUID()}@example.test`, role: 'member' })
  assert.equal(response.status(), 403)
  assert.equal(
    responseBody<{ errors: [{ code: string }] }>(response).errors[0].code,
    'missing_ability'
  )
}).skip(isSessionStrategy, ACCESS_TOKENS_ONLY)

test('bearer login uses the real token guard and password changes revoke issued tokens', async ({
  client,
  assert,
}) => {
  await limiter.clear(['memory'])
  const user = await User.create({
    fullName: 'Token Lifecycle User',
    email: `token-lifecycle-${randomUUID()}@example.test`,
    password: 'OriginalPass123!',
  })
  const login = await client.post('/api/v1/auth/login').json({
    email: user.email,
    password: 'OriginalPass123!',
  })
  assert.equal(login.status(), 200)
  const token = responseBody<{ data: { token: string; user: Record<string, unknown> } }>(login).data
    .token
  assert.isString(token)
  const storedToken = await db.from('auth_access_tokens').where('tokenable_id', user.id).first()
  assert.isNotNull(storedToken.expires_at)
  assert.deepEqual(JSON.parse(storedToken.abilities), ['*'])
  assert.notProperty(
    responseBody<{ data: { user: Record<string, unknown> } }>(login).data.user,
    'password'
  )
  const profile = await client.get('/api/v1/account/profile').bearerToken(token)
  assert.equal(profile.status(), 200)
  assert.notProperty(responseBody<{ data: Record<string, unknown> }>(profile).data, 'password')

  const change = await client.post('/api/v1/account/password').bearerToken(token).json({
    currentPassword: 'OriginalPass123!',
    newPassword: 'ReplacementPass123!',
    newPasswordConfirmation: 'ReplacementPass123!',
  })
  assert.equal(change.status(), 200)
  const revokedProfile = await client.get('/api/v1/account/profile').bearerToken(token)
  assert.equal(revokedProfile.status(), 401)

  const nextLogin = await client.post('/api/v1/auth/login').json({
    email: user.email,
    password: 'ReplacementPass123!',
  })
  assert.equal(nextLogin.status(), 200)
  const nextToken = responseBody<{ data: { token: string } }>(nextLogin).data.token
  const logout = await client.post('/api/v1/account/logout').bearerToken(nextToken)
  assert.equal(logout.status(), 200)
  const repeatedLogout = await client.post('/api/v1/account/logout').bearerToken(nextToken)
  assert.equal(repeatedLogout.status(), 401)
}).skip(isSessionStrategy, ACCESS_TOKENS_ONLY)

test('an in-flight bearer request is denied when its token is revoked after guard authentication', async ({
  client,
  assert,
}) => {
  await limiter.clear(['memory'])
  const user = await User.create({
    fullName: 'In-flight Token User',
    email: `inflight-token-${randomUUID()}@example.test`,
    password: 'OriginalPass123!',
  })
  const login = await client.post('/api/v1/auth/login').json({
    email: user.email,
    password: 'OriginalPass123!',
  })
  assert.equal(login.status(), 200)
  const token = responseBody<{ data: { token: string } }>(login).data.token
  const original = AuthMiddleware.prototype.handle
  let entered!: () => void
  let resume!: () => void
  const authenticated = new Promise<void>((resolve) => {
    entered = resolve
  })
  const paused = new Promise<void>((resolve) => {
    resume = resolve
  })
  AuthMiddleware.prototype.handle = async function (ctx, next, options) {
    return original.call(
      this,
      ctx,
      async () => {
        entered()
        await paused
        return next()
      },
      options
    )
  }
  try {
    const pending = Promise.resolve(client.get('/api/v1/account/profile').bearerToken(token))
    await authenticated
    const kit = await app.container.make(AccountKit)
    await kit.emailPasswordManagement.changePassword({
      actorId: user.id,
      currentPassword: 'OriginalPass123!',
      newPassword: 'ReplacementPass123!',
    })
    resume()
    const response = await pending
    assert.equal(response.status(), 401)
  } finally {
    resume()
    AuthMiddleware.prototype.handle = original
  }
}).skip(isSessionStrategy, ACCESS_TOKENS_ONLY)

test('real token issuance cannot survive a reset committed on either side of creation', async ({
  client,
  assert,
}) => {
  const kit = await app.container.make(AccountKit)
  for (const order of ['token-first', 'reset-first'] as const) {
    const user = await User.create({
      fullName: 'Reset Race User',
      email: `reset-race-${order}-${randomUUID()}@example.test`,
      password: 'OriginalPass123!',
    })
    await kit.passwordReset.request({ email: user.email, clientKey: randomUUID() })
    const notice = notifications.events.findLast(
      (event) => event.kind === 'recovery' && event.recipient === user.email
    )
    if (!notice) throw new Error('Missing reset proof')
    const proof = decodeURIComponent(new URL(notice.value).pathname.split('/').at(-1)!)
    let release!: () => void
    let entered!: () => void
    const paused = new Promise<void>((resolve) => {
      release = resolve
    })
    const atIssuance = new Promise<void>((resolve) => {
      entered = resolve
    })
    let tokenValue: string | undefined
    const pending = kit.authentication.login(
      { email: user.email, password: 'OriginalPass123!', clientKey: randomUUID() },
      {
        strategy: 'access_tokens',
        name: 'api',
        async establish() {
          if (order === 'reset-first') {
            entered()
            await paused
          }
          const token = await User.accessTokens.create(user, ['*'], { expiresIn: '1d' })
          tokenValue = token.value!.release()
          if (order === 'token-first') {
            entered()
            await paused
          }
          return { identifier: token.identifier }
        },
        async terminate(credential) {
          if (credential) await User.accessTokens.delete(user, credential.identifier)
        },
      }
    )
    await atIssuance
    assert.lengthOf(
      await db.from('auth_access_tokens').where('tokenable_id', user.id),
      order === 'token-first' ? 1 : 0
    )
    await kit.passwordReset.reset({ token: proof, password: 'ReplacementPass123!' })
    release()
    await assert.rejects(() => pending, 'Invalid email or password')
    assert.isString(tokenValue)
    assert.lengthOf(await db.from('auth_access_tokens').where('tokenable_id', user.id), 0)
    const replay = await client.get('/api/v1/account/profile').bearerToken(tokenValue!)
    assert.equal(replay.status(), 401)
  }
}).skip(isSessionStrategy, ACCESS_TOKENS_ONLY)
