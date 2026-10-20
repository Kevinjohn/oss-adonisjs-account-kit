/* eslint-disable @unicorn/no-await-expression-member -- Inline awaited requests keep each assertion tied to the HTTP operation it verifies. */

import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import User from '#models/user'
import { notifications } from '#services/account_kit_notifications'
import { resetAccountState } from '#tests/helpers/account_state'
import { tokenFrom } from '#tests/helpers/link_tokens'
import { responseBody } from '#tests/helpers/response_body'

test('signup and login over HTTP normalize email, require verification, and hide duplicates', async ({
  client,
  assert,
}) => {
  await resetAccountState()

  const missingProfile = await client.post('/api/v1/auth/signup').json({
    email: 'missing-profile@example.test',
    password: 'MissingPass123!',
    passwordConfirmation: 'MissingPass123!',
  } as never)
  assert.equal(missingProfile.status(), 422)
  const registration = await client.post('/api/v1/auth/signup').json({
    fullName: 'Registration User',
    email: ' Registration@Example.Test ',
    password: 'RegistrationPass123!',
    passwordConfirmation: 'RegistrationPass123!',
  })
  assert.equal(registration.status(), 200)
  const registrationBody = responseBody<{
    data: { user: { fullName: string; email: string }; token: string }
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
