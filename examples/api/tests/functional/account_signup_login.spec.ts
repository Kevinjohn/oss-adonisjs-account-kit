/* eslint-disable @unicorn/no-await-expression-member -- Inline awaited requests keep each assertion tied to the HTTP operation it verifies. */

import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import limiter from '@adonisjs/limiter/services/main'
import User from '#models/user'
import { notifications } from '#services/account_kit_notifications'
import { tokenFrom } from '#tests/helpers/link_tokens'
import { responseBody } from '#tests/helpers/response_body'
import { truncateDatabase } from '#tests/helpers/database'

test.group('Account signup login', (group) => {
  group.each.setup(truncateDatabase)

  test('signup and login over HTTP normalize email, require verification, and reject duplicates', async ({
    client,
    assert,
  }) => {
    notifications.reset()

    for (const [index, fullName] of [undefined, null, '   '].entries()) {
      const email = `optional-name-${index}@example.test`
      const registration = await client.post('/api/v1/auth/signup').json({
        ...(fullName === undefined ? {} : { fullName }),
        email,
        password: 'OptionalNamePass123!',
        passwordConfirmation: 'OptionalNamePass123!',
      })
      assert.equal(registration.status(), 200)
      const registered = await User.findByOrFail('email', email)
      assert.isNull(registered.fullName)
    }

    notifications.reset()
    const longName = `  ${'x'.repeat(255)}  `
    const longNameSignup = await client.post('/api/v1/auth/signup').json({
      fullName: longName,
      email: 'long-name@example.test',
      password: 'LongNamePass123!',
      passwordConfirmation: 'LongNamePass123!',
    })
    assert.equal(longNameSignup.status(), 200)
    assert.equal(
      (await User.findByOrFail('email', 'long-name@example.test')).fullName,
      'x'.repeat(255)
    )
    const tooLongSignup = await client.post('/api/v1/auth/signup').json({
      fullName: 'x'.repeat(256),
      email: 'too-long-name@example.test',
      password: 'TooLongNamePass123!',
      passwordConfirmation: 'TooLongNamePass123!',
    })
    assert.equal(tooLongSignup.status(), 422)
    notifications.reset()
    // Five signups spent this client's signup budget; start the next journey with a fresh one.
    await limiter.clear()

    const registration = await client.post('/api/v1/auth/signup').json({
      fullName: 'Registration User',
      email: ' Registration@Example.Test ',
      password: 'RegistrationPass123!',
      passwordConfirmation: 'RegistrationPass123!',
    })
    assert.equal(registration.status(), 200)
    const registrationBody = responseBody<{
      data: { user: { fullName: string | null; email: string }; token: string }
    }>(registration)
    assert.equal(registrationBody.data.user.fullName, 'Registration User')
    assert.equal(registrationBody.data.user.email, 'registration@example.test')
    const registered = await User.findByOrFail('email', 'registration@example.test')
    assert.equal(registered.unverifiedEmail, registered.email)
    assert.isNull(registered.emailVerifiedAt)
    assert.lengthOf(
      notifications.events.filter((event) => event.kind === 'verification'),
      1
    )
    const registrationToken = tokenFrom(
      notifications.events.filter((event) => event.kind === 'verification').at(-1)!.value
    )
    const activation = await client
      .post(`/api/v1/auth/email-verification/${encodeURIComponent(registrationToken)}`)
      .json({ password: 'ClaimantPass123!', passwordConfirmation: 'ClaimantPass123!' })
    assert.equal((activation.body() as { result: string }).result, 'verified')
    assert.isNull((await User.findByOrFail('email', registered.email)).unverifiedEmail)
    notifications.reset()
    assert.isString(registrationBody.data.token)
    assert.notProperty(registrationBody.data.user, 'password')
    const duplicate = await client.post('/api/v1/auth/signup').json({
      fullName: 'Duplicate User',
      email: 'REGISTRATION@EXAMPLE.TEST',
      password: 'DuplicatePass123!',
      passwordConfirmation: 'DuplicatePass123!',
    })
    assert.equal(duplicate.status(), 422)
    assert.deepEqual(duplicate.body(), {
      errors: [{ field: 'email', rule: 'unique', message: 'The email has already been taken' }],
    })
    await db.table('role_assignments').insert({ user_id: registered.id, role: 'disabled' })
    const restrictedDuplicate = await client.post('/api/v1/auth/signup').json({
      fullName: 'Duplicate User',
      email: registered.email,
      password: 'DuplicatePass123!',
      passwordConfirmation: 'DuplicatePass123!',
    })
    assert.equal(restrictedDuplicate.status(), 422)
    assert.deepEqual(restrictedDuplicate.body(), duplicate.body())
    await db.from('role_assignments').where('user_id', registered.id).delete()
    const normalizedLogin = await client.post('/api/v1/auth/login').json({
      email: ' REGISTRATION@EXAMPLE.TEST ',
      password: 'ClaimantPass123!',
    })
    assert.equal(normalizedLogin.status(), 200)
  })

  test('signup is rate limited per client before it creates accounts', async ({
    client,
    assert,
  }) => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const response = await client.post('/api/v1/auth/signup').json({
        email: `limited-${attempt}@example.test`,
        password: 'LimitedPass123!',
        passwordConfirmation: 'LimitedPass123!',
      })
      assert.equal(response.status(), 200)
    }
    const limited = await client.post('/api/v1/auth/signup').json({
      email: 'limited-over@example.test',
      password: 'LimitedPass123!',
      passwordConfirmation: 'LimitedPass123!',
    })
    assert.equal(limited.status(), 429)
    assert.isNull(await User.findBy('email', 'limited-over@example.test'))
  })
})
