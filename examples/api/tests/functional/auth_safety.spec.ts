import { randomUUID } from 'node:crypto'
import { test } from '@japa/runner'
import limiter from '@adonisjs/limiter/services/main'
import db from '@adonisjs/lucid/services/db'
import app from '@adonisjs/core/services/app'
import { AccountKit } from 'adonisjs-account-kit'
import User from '#models/user'
import AuthMiddleware from '#middleware/auth_middleware'
import { clientRateLimitKey, identityRateLimitKey } from '#start/limiter'

const responseBody = <T>(response: { body(): unknown }) => response.body() as T

test('login limits known and unknown identities independently after normalization', async ({
  client,
  assert,
}) => {
  await limiter.clear(['memory'])
  const identity = randomUUID()
  const email = `login-safety-${identity}@example.test`
  const address = 'known-client@example.test'
  assert.equal(
    identityRateLimitKey('192.0.2.10', ` ${address.toUpperCase()} `),
    identityRateLimitKey('192.0.2.10', address)
  )
  assert.notEqual(
    identityRateLimitKey('192.0.2.10', address),
    identityRateLimitKey('192.0.2.11', address)
  )
  assert.notEqual(clientRateLimitKey('192.0.2.10'), clientRateLimitKey('192.0.2.11'))
  assert.notInclude(identityRateLimitKey('192.0.2.10', address), address)
  const user = await User.create({
    fullName: 'Login Safety User',
    email,
    password: 'LoginSafetyPass123!',
  })

  const successfulLogin = await client.post('/api/v1/auth/login').json({
    email: user.email,
    password: 'LoginSafetyPass123!',
  })
  assert.equal(successfulLogin.status(), 200)

  const longWrongPasswordLogin = await client.post('/api/v1/auth/login').json({
    email: `long-login-${identity}@example.test`,
    password: 'x'.repeat(129),
  })
  assert.equal(longWrongPasswordLogin.status(), 400)

  for (let attempt = 0; attempt < 4; attempt++) {
    const failedLogin = await client.post('/api/v1/auth/login').json({
      email: attempt === 0 ? ` ${email.toUpperCase()} ` : user.email,
      password: 'wrong-password',
    })
    assert.equal(failedLogin.status(), 400)
  }
  const normalizedIdentityLimit = await client.post('/api/v1/auth/login').json({
    email: email.toUpperCase(),
    password: 'wrong-password',
  })
  assert.equal(normalizedIdentityLimit.status(), 400)
  const blockedIdentity = await client.post('/api/v1/auth/login').json({
    email,
    password: 'wrong-password',
  })
  assert.equal(blockedIdentity.status(), 429)

  const differentIdentity = await client.post('/api/v1/auth/login').json({
    email: `another-${identity}@example.test`,
    password: 'wrong-password',
  })
  assert.equal(differentIdentity.status(), 400)

  await limiter.clear(['memory'])

  for (let attempt = 0; attempt < 5; attempt++) {
    const unknownLogin = await client.post('/api/v1/auth/login').json({
      email: `unknown-${identity}@example.test`,
      password: 'wrong-password',
    })
    assert.equal(unknownLogin.status(), 400)
  }
  const limitedUnknownLogin = await client.post('/api/v1/auth/login').json({
    email: `unknown-${identity}@example.test`,
    password: 'wrong-password',
  })
  assert.equal(limitedUnknownLogin.status(), 429)
})

test('signup accepts a password within the shared 128 character limit', async ({
  client,
  assert,
}) => {
  await limiter.clear(['memory'])
  const password = `LongPassword123!${'x'.repeat(112)}`
  const registration = await client.post('/api/v1/auth/signup').json({
    fullName: 'Long Password User',
    email: `long-password-${randomUUID()}@example.test`,
    password,
    passwordConfirmation: password,
  })
  assert.equal(registration.status(), 200)
  assert.isString(responseBody<{ data: { token: string } }>(registration).data.token)

  const tooLongPassword = `${password}x`
  const rejectedRegistration = await client.post('/api/v1/auth/signup').json({
    fullName: 'Password Limit User',
    email: `password-limit-${randomUUID()}@example.test`,
    password: tooLongPassword,
    passwordConfirmation: tooLongPassword,
  })
  assert.equal(rejectedRegistration.status(), 422)
})

test('login limits each client across rotating identities', async ({ client, assert }) => {
  await limiter.clear(['memory'])
  const clientId = randomUUID()

  for (let attempt = 0; attempt < 10; attempt++) {
    const response = await client.post('/api/v1/auth/login').json({
      email: `rotating-${clientId}-${attempt}@example.test`,
      password: 'wrong-password',
    })
    assert.equal(response.status(), 400)
  }

  const limitedClient = await client.post('/api/v1/auth/login').json({
    email: `rotating-${clientId}-final@example.test`,
    password: 'wrong-password',
  })
  assert.equal(limitedClient.status(), 429)
})

test('bearer login uses the real token guard and password changes revoke issued tokens', async ({
  client,
  assert,
}) => {
  if (process.env.ACCOUNT_KIT_AUTH_STRATEGY === 'session') return
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

  const change = await client.post('/account-kit/credentials/password').bearerToken(token).json({
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
})

test('an in-flight bearer request is denied when its token is revoked after guard authentication', async ({
  client,
  assert,
}) => {
  if (process.env.ACCOUNT_KIT_AUTH_STRATEGY === 'session') return
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
})
