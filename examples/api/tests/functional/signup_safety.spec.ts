import { randomUUID } from 'node:crypto'
import { test } from '@japa/runner'
import limiter from '@adonisjs/limiter/services/main'
import db from '@adonisjs/lucid/services/db'
import app from '@adonisjs/core/services/app'
import { AccountKit, ThrottledError } from 'adonisjs-account-kit'
import { notifications } from '#services/account_kit_notifications'
import User from '#models/user'
import accountKitConfig from '#config/account_kit'
import { referencePasswordLimits } from '#validators/password'
import { captureFollowUpDiagnostics } from '#tests/helpers/follow_up_diagnostics'
import { ACCESS_TOKENS_ONLY, isSessionStrategy } from '#tests/helpers/strategy'
import { responseBody } from '#tests/helpers/response_body'

test('signup issues a limited bearer token and fresh-password claim revokes it', async ({
  client,
  assert,
}) => {
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
  const blocked = await client.get('/api/v1/account/invitations').bearerToken(token)
  assert.equal(blocked.status(), 403)
  assert.equal(
    (blocked.body() as unknown as { errors: [{ code: string }] }).errors[0].code,
    'E_ACCOUNT_KIT_UNVERIFIED_EMAIL'
  )
  const provision = notifications.events.find((event) => event.kind === 'verification')
  assert.isDefined(provision)
  const proof = new URL(provision!.value).pathname.split('/').at(-1)!
  const claim = await client
    .post(`/api/v1/auth/email-verification/${proof}`)
    .json({ password: 'ClaimantPass123!', passwordConfirmation: 'ClaimantPass123!' })
  assert.equal(claim.status(), 200, JSON.stringify(claim.body()))
  const previousToken = await client.get('/api/v1/account/profile').bearerToken(token)
  assert.equal(previousToken.status(), 401)
  const previousPassword = await client
    .post('/api/v1/auth/login')
    .json({ email, password: 'PrecreatorPass123!' })
  assert.equal(previousPassword.status(), 401)
  const claimantPassword = await client
    .post('/api/v1/auth/login')
    .json({ email, password: 'ClaimantPass123!' })
  assert.equal(claimantPassword.status(), 200)
}).skip(isSessionStrategy, ACCESS_TOKENS_ONLY)

test('committed signup delivery and observer failures return recovery guidance', async ({
  client,
  assert,
}) => {
  for (const failure of ['delivery', 'observer'] as const) {
    notifications.reset()
    notifications.failVerification = failure === 'delivery'
    notifications.failLifecycle = failure === 'observer'
    const email = `committed-${failure}-${randomUUID()}@example.test`
    const { result: response, entries } = await captureFollowUpDiagnostics(() =>
      client.post('/api/v1/auth/signup').json({
        fullName: 'Committed Signup',
        email,
        password: 'CommittedPass123!',
        passwordConfirmation: 'CommittedPass123!',
      })
    )
    assert.equal(response.status(), 202, JSON.stringify(response.body()))
    assert.isTrue((response.body() as unknown as { accountCreated: boolean }).accountCreated)
    assert.deepEqual(entries, [
      {
        event: 'account_kit_follow_up_failed',
        operation: 'registration.signup',
        failure: failure === 'delivery' ? 'delivery' : 'post_commit',
      },
    ])
    const user = await User.findByOrFail('email', email)
    const proofs = await db.from('email_verification_tokens').where('tokenable_id', user.id)
    assert.lengthOf(proofs, 1)
    notifications.failVerification = false
    notifications.failLifecycle = false
    notifications.events.length = 0
    const suppressed = await client
      .post('/api/v1/account/email-verification/send')
      .loginAs(user)
      .json({})
    assert.equal(suppressed.status(), 200, JSON.stringify(suppressed.body()))
    assert.equal((suppressed.body() as { result: string }).result, 'sent')
    assert.lengthOf(notifications.events, 0)
    await db
      .from('email_verification_tokens')
      .where('tokenable_id', user.id)
      .update({ created_at: new Date(Date.now() - 120_000).toISOString() })
    const resent = await client
      .post('/api/v1/account/email-verification/send')
      .loginAs(user)
      .json({})
    assert.equal(resent.status(), 200, JSON.stringify(resent.body()))
    assert.equal((resent.body() as { result: string }).result, 'sent')
    assert.isTrue(notifications.events.some((event) => event.kind === 'verification'))
  }
  notifications.reset()
}).skip(isSessionStrategy, ACCESS_TOKENS_ONLY)

test('committed signup survives credential throttling and guard failure', async ({
  client,
  assert,
}) => {
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
      const { result: response, entries } = await captureFollowUpDiagnostics(() =>
        client.post('/api/v1/auth/signup').json({
          fullName: 'Committed Signup',
          email,
          password: 'CommittedPass123!',
          passwordConfirmation: 'CommittedPass123!',
        })
      )
      assert.equal(response.status(), 202, JSON.stringify(response.body()))
      assert.isTrue((response.body() as { accountCreated: boolean }).accountCreated)
      assert.deepEqual(entries, [
        {
          event: 'account_kit_follow_up_failed',
          operation: 'registration.credential_establish',
          failure: 'credential_establishment',
        },
      ])
      const user = await User.findByOrFail('email', email)
      const proofs = await db.from('email_verification_tokens').where('tokenable_id', user.id)
      assert.lengthOf(proofs, 1)
    } finally {
      if (original) Object.defineProperty(kit, 'authentication', original)
      else Reflect.deleteProperty(kit, 'authentication')
    }
  }
}).skip(isSessionStrategy, ACCESS_TOKENS_ONLY)

test('signup maps an application-restricted duplicate to the uniform email error', async ({
  client,
  assert,
}) => {
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
}).skip(isSessionStrategy, ACCESS_TOKENS_ONLY)

test('signup accepts a password within the shared 256 character limit', async ({
  client,
  assert,
}) => {
  assert.equal(accountKitConfig.passwordPolicy.minLength, referencePasswordLimits.minLength)
  assert.equal(accountKitConfig.passwordPolicy.maxLength, referencePasswordLimits.maxLength)
  assert.isFalse(accountKitConfig.passwordPolicy.letters)
  assert.isFalse(accountKitConfig.passwordPolicy.mixedCase)
  assert.isFalse(accountKitConfig.passwordPolicy.numbers)
  assert.isFalse(accountKitConfig.passwordPolicy.symbols)
  assert.equal(accountKitConfig.passwordPolicy.minScore, 0)
  assert.deepEqual(referencePasswordLimits, { minLength: 8, maxLength: 256 })
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

  const tooShortPassword = 'Short1!'
  const rejectedShort = await client.post('/api/v1/auth/signup').json({
    fullName: 'Short Password User',
    email: `short-password-${randomUUID()}@example.test`,
    password: tooShortPassword,
    passwordConfirmation: tooShortPassword,
  })
  assert.equal(rejectedShort.status(), 422)

  const tooLongPassword = `${password}x`
  const rejectedRegistration = await client.post('/api/v1/auth/signup').json({
    fullName: 'Password Limit User',
    email: `password-limit-${randomUUID()}@example.test`,
    password: tooLongPassword,
    passwordConfirmation: tooLongPassword,
  })
  assert.equal(rejectedRegistration.status(), 422)
}).skip(isSessionStrategy, ACCESS_TOKENS_ONLY)
