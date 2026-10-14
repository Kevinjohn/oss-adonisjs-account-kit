import { randomUUID } from 'node:crypto'
import { test } from '@japa/runner'
import limiter from '@adonisjs/limiter/services/main'
import User from '#models/user'
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
  assert.equal(normalizedIdentityLimit.status(), 429)

  const differentIdentity = await client.post('/api/v1/auth/login').json({
    email: `another-${identity}@example.test`,
    password: 'wrong-password',
  })
  assert.equal(differentIdentity.status(), 400)

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

  for (let attempt = 0; attempt < 20; attempt++) {
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
