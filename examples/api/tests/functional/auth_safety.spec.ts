import { createHmac, hkdfSync, randomUUID } from 'node:crypto'
import { test } from '@japa/runner'
import limiter from '@adonisjs/limiter/services/main'
import db from '@adonisjs/lucid/services/db'
import app from '@adonisjs/core/services/app'
import { AccountKit, ThrottledError } from 'adonisjs-account-kit'
import { notifications } from '#services/account_kit_notifications'
import User from '#models/user'
import AuthMiddleware from '#middleware/auth_middleware'
import env from '#start/env'

const responseBody = <T>(response: { body(): unknown }) => response.body() as T

function storedLoginKey(operation: string, value: string) {
  const secret = env.get('APP_KEY').release()
  const derived = Buffer.from(
    hkdfSync('sha256', secret, 'adonisjs-account-kit', 'limiter-key-v1', 32)
  )
  return `account-kit:v1:${createHmac('sha256', derived)
    .update(JSON.stringify(['default', operation, value]))
    .digest('hex')}`
}

test('signup issues a limited bearer token and fresh-password claim revokes it', async ({
  client,
  assert,
}) => {
  if (process.env.ACCOUNT_KIT_AUTH_STRATEGY === 'session') return
  notifications.reset()
  const email = `claim-${randomUUID()}@example.test`
  const signup = await client.post('/api/v1/auth/signup').json({
    fullName: 'Claim User',
    email,
    password: 'PrecreatorPass123!',
    passwordConfirmation: 'PrecreatorPass123!',
  })
  assert.equal(signup.status(), 200, JSON.stringify(signup.body()))
  const token = responseBody<{ data: { token: string } }>(signup).data.token
  const blocked = await client.get('/account-kit/invitations').bearerToken(token)
  assert.equal(blocked.status(), 403)
  assert.equal((blocked.body() as unknown as { code: string }).code, 'unverified_email')
  const provision = notifications.events.find((event) => event.kind === 'verification')
  assert.isDefined(provision)
  const proof = new URL(provision!.value).pathname.split('/').at(-1)!
  const claim = await client
    .post(`/account-kit/verification/${proof}`)
    .json({ password: 'ClaimantPass123!', passwordConfirmation: 'ClaimantPass123!' })
  assert.equal(claim.status(), 200, JSON.stringify(claim.body()))
  const previousToken = await client.get('/api/v1/account/profile').bearerToken(token)
  assert.equal(previousToken.status(), 401)
  const previousPassword = await client
    .post('/api/v1/auth/login')
    .json({ email, password: 'PrecreatorPass123!' })
  assert.equal(previousPassword.status(), 400)
  const claimantPassword = await client
    .post('/api/v1/auth/login')
    .json({ email, password: 'ClaimantPass123!' })
  assert.equal(claimantPassword.status(), 200)
})

test('committed signup delivery and observer failures return recovery guidance', async ({
  client,
  assert,
}) => {
  if (process.env.ACCOUNT_KIT_AUTH_STRATEGY === 'session') return
  for (const failure of ['delivery', 'observer'] as const) {
    notifications.reset()
    notifications.failVerification = failure === 'delivery'
    notifications.failLifecycle = failure === 'observer'
    const email = `committed-${failure}-${randomUUID()}@example.test`
    const response = await client.post('/api/v1/auth/signup').json({
      fullName: 'Committed Signup',
      email,
      password: 'CommittedPass123!',
      passwordConfirmation: 'CommittedPass123!',
    })
    assert.equal(response.status(), 202, JSON.stringify(response.body()))
    assert.isTrue((response.body() as unknown as { accountCreated: boolean }).accountCreated)
    const user = await User.findByOrFail('email', email)
    const proofs = await db.from('email_verification_tokens').where('tokenable_id', user.id)
    assert.lengthOf(proofs, 1)
    notifications.failVerification = false
    notifications.failLifecycle = false
    notifications.events.length = 0
    const suppressed = await client.post('/account-kit/verification/send').loginAs(user).json({})
    assert.equal(suppressed.status(), 200, JSON.stringify(suppressed.body()))
    assert.equal((suppressed.body() as { result: string }).result, 'sent')
    assert.lengthOf(notifications.events, 0)
    await db
      .from('email_verification_tokens')
      .where('tokenable_id', user.id)
      .update({ created_at: new Date(Date.now() - 120_000).toISOString() })
    const resent = await client.post('/account-kit/verification/send').loginAs(user).json({})
    assert.equal(resent.status(), 200, JSON.stringify(resent.body()))
    assert.equal((resent.body() as { result: string }).result, 'sent')
    assert.isTrue(notifications.events.some((event) => event.kind === 'verification'))
  }
  notifications.reset()
})

test('committed signup survives credential throttling and guard failure', async ({
  client,
  assert,
}) => {
  if (process.env.ACCOUNT_KIT_AUTH_STRATEGY === 'session') return
  const kit = await app.container.make(AccountKit)
  const original = Object.getOwnPropertyDescriptor(kit, 'authentication')
  for (const [kind, failure] of [
    ['throttled', new ThrottledError(60)],
    ['guard', new Error('Credential guard failed')],
  ] as const) {
    const email = `committed-${kind}-${randomUUID()}@example.test`
    Object.defineProperty(kit, 'authentication', {
      configurable: true,
      get: () => ({
        login: async () => {
          throw failure
        },
      }),
    })
    try {
      const response = await client.post('/api/v1/auth/signup').json({
        fullName: 'Committed Signup',
        email,
        password: 'CommittedPass123!',
        passwordConfirmation: 'CommittedPass123!',
      })
      assert.equal(response.status(), 202, JSON.stringify(response.body()))
      assert.isTrue((response.body() as { accountCreated: boolean }).accountCreated)
      const user = await User.findByOrFail('email', email)
      const proofs = await db.from('email_verification_tokens').where('tokenable_id', user.id)
      assert.lengthOf(proofs, 1)
    } finally {
      if (original) Object.defineProperty(kit, 'authentication', original)
      else Reflect.deleteProperty(kit, 'authentication')
    }
  }
})

test('signup maps an application-restricted duplicate to the uniform email error', async ({
  client,
  assert,
}) => {
  if (process.env.ACCOUNT_KIT_AUTH_STRATEGY === 'session') return
  const email = `restricted-duplicate-${randomUUID()}@example.test`
  const user = await User.create({
    fullName: 'Restricted Existing User',
    email,
    password: 'ExistingPass123!',
  })
  await db.table('role_assignments').insert({ user_id: user.id, role: 'disabled' })
  const duplicate = await client.post('/api/v1/auth/signup').json({
    fullName: 'Another User',
    email: email.toUpperCase(),
    password: 'NewPass123!',
    passwordConfirmation: 'NewPass123!',
  })
  assert.equal(duplicate.status(), 422)
  assert.deepEqual(duplicate.body(), {
    errors: [{ field: 'email', rule: 'unique', message: 'The email has already been taken' }],
  })
})

test('login limits known and unknown identities independently after normalization', async ({
  client,
  assert,
}) => {
  await limiter.clear(['memory'])
  const identity = randomUUID()
  const email = `login-safety-${identity}@example.test`
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
  const clientKey = storedLoginKey('login:client', '127.0.0.1')
  const identityKey = storedLoginKey('login:identity', `127.0.0.1\0${email}`)
  const clientBudget = limiter.use({ requests: 10, duration: '1m' })
  const identityBudget = limiter.use({ requests: 5, duration: '1m', blockDuration: '20m' })
  const storedClient = await clientBudget.get(clientKey)
  const storedIdentity = await identityBudget.get(identityKey)
  assert.equal(storedClient?.remaining, 5)
  assert.equal(storedIdentity?.remaining, 1)
  assert.isNull(
    await identityBudget.get(storedLoginKey('login:identity', `127.0.0.1\0${email.toUpperCase()}`))
  )
  assert.isNull(await clientBudget.get(storedLoginKey('login:client', '192.0.2.11')))
  assert.isNull(await clientBudget.get(`login:client:127.0.0.1`))
  assert.notInclude(identityKey, email)
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

test('signup accepts a password within the shared 256 character limit', async ({
  client,
  assert,
}) => {
  await limiter.clear(['memory'])
  const password = 'LongPassword123!'.padEnd(256, 'x')
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

test('a bearer token without the invitation ability cannot send an invitation', async ({
  client,
  assert,
}) => {
  if (process.env.ACCOUNT_KIT_AUTH_STRATEGY === 'session') return
  const user = await User.create({
    fullName: 'Limited Token User',
    email: `limited-token-${randomUUID()}@example.test`,
    password: 'OriginalPass123!',
  })
  const token = await User.accessTokens.create(user, ['profile:read'], { expiresIn: '1d' })
  const response = await client
    .post('/account-kit/invitations')
    .bearerToken(token.value!.release())
    .json({ email: `invitee-${randomUUID()}@example.test`, role: 'member' })
  assert.equal(response.status(), 403)
  assert.equal(
    responseBody<{ errors: [{ code: string }] }>(response).errors[0].code,
    'missing_ability'
  )
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

test('real token issuance cannot survive a reset committed on either side of creation', async ({
  client,
  assert,
}) => {
  if (process.env.ACCOUNT_KIT_AUTH_STRATEGY === 'session') return
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
})
