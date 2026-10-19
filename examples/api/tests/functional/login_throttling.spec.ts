import { createHmac, hkdfSync, randomUUID } from 'node:crypto'
import { test } from '@japa/runner'
import limiter from '@adonisjs/limiter/services/main'
import User from '#models/user'
import env from '#start/env'
import { responseBody } from '#tests/helpers/response_body'
import { truncateDatabase } from '#tests/helpers/database'

function storedLoginKey(operation: string, value: string) {
  const secret = env.get('APP_KEY').release()
  const derived = Buffer.from(
    hkdfSync('sha256', secret, 'adonisjs-account-kit', 'limiter-key-v1', 32)
  )
  return `account-kit:v1:${createHmac('sha256', derived)
    .update(JSON.stringify(['default', operation, value]))
    .digest('hex')}`
}

test.group('Login throttling', (group) => {
  group.each.setup(truncateDatabase)

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
    assert.equal(longWrongPasswordLogin.status(), 401)

    for (let attempt = 0; attempt < 4; attempt++) {
      const failedLogin = await client.post('/api/v1/auth/login').json({
        email: attempt === 0 ? ` ${email.toUpperCase()} ` : user.email,
        password: 'wrong-password',
      })
      assert.equal(failedLogin.status(), 401)
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
      await identityBudget.get(
        storedLoginKey('login:identity', `127.0.0.1\0${email.toUpperCase()}`)
      )
    )
    assert.isNull(await clientBudget.get(storedLoginKey('login:client', '192.0.2.11')))
    assert.isNull(await clientBudget.get(`login:client:127.0.0.1`))
    assert.notInclude(identityKey, email)
    const normalizedIdentityLimit = await client.post('/api/v1/auth/login').json({
      email: email.toUpperCase(),
      password: 'wrong-password',
    })
    assert.equal(normalizedIdentityLimit.status(), 401)
    const blockedIdentity = await client.post('/api/v1/auth/login').json({
      email,
      password: 'wrong-password',
    })
    assert.equal(blockedIdentity.status(), 429)
    assert.equal(
      responseBody<{ errors: [{ code: string }] }>(blockedIdentity).errors[0].code,
      'E_ACCOUNT_KIT_THROTTLED'
    )
    assert.isAbove(Number(blockedIdentity.header('retry-after')), 0)

    const differentIdentity = await client.post('/api/v1/auth/login').json({
      email: `another-${identity}@example.test`,
      password: 'wrong-password',
    })
    assert.equal(differentIdentity.status(), 401)

    await limiter.clear(['memory'])

    for (let attempt = 0; attempt < 5; attempt++) {
      const unknownLogin = await client.post('/api/v1/auth/login').json({
        email: `unknown-${identity}@example.test`,
        password: 'wrong-password',
      })
      assert.equal(unknownLogin.status(), 401)
    }
    const limitedUnknownLogin = await client.post('/api/v1/auth/login').json({
      email: `unknown-${identity}@example.test`,
      password: 'wrong-password',
    })
    assert.equal(limitedUnknownLogin.status(), 429)
  }).teardown(() => limiter.clear(['memory']))

  test('login limits each client across rotating identities', async ({ client, assert }) => {
    await limiter.clear(['memory'])
    const clientId = randomUUID()

    for (let attempt = 0; attempt < 10; attempt++) {
      const response = await client.post('/api/v1/auth/login').json({
        email: `rotating-${clientId}-${attempt}@example.test`,
        password: 'wrong-password',
      })
      assert.equal(response.status(), 401)
    }

    const limitedClient = await client.post('/api/v1/auth/login').json({
      email: `rotating-${clientId}-final@example.test`,
      password: 'wrong-password',
    })
    assert.equal(limitedClient.status(), 429)
  }).teardown(() => limiter.clear(['memory']))
})
