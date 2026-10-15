/* eslint-disable @unicorn/no-await-expression-member -- Keep response checks beside their requests. */

import { randomUUID } from 'node:crypto'
import { test } from '@japa/runner'
import app from '@adonisjs/core/services/app'
import db from '@adonisjs/lucid/services/db'
import { AccountKit, DeliveryError, PostCommitError } from 'adonisjs-account-kit'
import User from '#models/user'
import { notifications } from '#services/account_kit_notifications'
import { reportCommittedFailure } from '#services/committed_failure_diagnostic'

const proofFrom = (url: string) => decodeURIComponent(new URL(url).pathname.split('/').at(-1)!)

test('committed follow-up diagnostics omit private error details', async ({ assert }) => {
  const reported: Array<{ details: object; message: string }> = []
  const logger = {
    error(details: object, message: string) {
      reported.push({ details, message })
    },
  }
  reportCommittedFailure(
    logger,
    new DeliveryError('secret proof and recipient@example.test'),
    'password_reset.request'
  )
  reportCommittedFailure(
    logger,
    new PostCommitError('secret proof and recipient@example.test'),
    'password_reset.complete'
  )
  assert.deepEqual(reported, [
    {
      details: {
        event: 'account_kit_follow_up_failed',
        operation: 'password_reset.request',
        failure: 'delivery',
      },
      message: 'Account operation committed but a follow-up failed',
    },
    {
      details: {
        event: 'account_kit_follow_up_failed',
        operation: 'password_reset.complete',
        failure: 'post_commit',
      },
      message: 'Account operation committed but a follow-up failed',
    },
  ])
})

test('bearer logout revokes only the current token and repeat is unauthenticated', async ({
  client,
  assert,
}) => {
  if (process.env.ACCOUNT_KIT_AUTH_STRATEGY === 'session') return
  const user = await User.create({
    fullName: 'Token Logout User',
    email: `token-logout-${randomUUID()}@example.test`,
    password: 'OriginalPass123!',
  })
  const credentials: string[] = []
  let firstLoginWindow: { start: number; end: number } | undefined
  for (let index = 0; index < 2; index++) {
    const start = Date.now()
    const login = await client
      .post('/api/v1/auth/login')
      .json({ email: user.email, password: 'OriginalPass123!' })
    const end = Date.now()
    assert.equal(login.status(), 200)
    if (index === 0) firstLoginWindow = { start, end }
    credentials.push((login.body() as unknown as { data: { token: string } }).data.token)
  }
  const firstToken = await db
    .from('auth_access_tokens')
    .where('tokenable_id', user.id)
    .orderBy('id', 'asc')
    .first()
  const expiresAt = new Date(firstToken.expires_at).getTime()
  assert.isAtLeast(expiresAt, firstLoginWindow!.start + 86_400_000 - 1_000)
  assert.isAtMost(expiresAt, firstLoginWindow!.end + 86_400_000 + 1_000)
  const logout = await client.post('/api/v1/account/logout').bearerToken(credentials[0])
  assert.equal(logout.status(), 200)
  assert.equal(
    (await client.get('/api/v1/account/profile').bearerToken(credentials[0])).status(),
    401
  )
  assert.equal(
    (await client.post('/api/v1/account/logout').bearerToken(credentials[0])).status(),
    401
  )
  assert.equal(
    (await client.get('/api/v1/account/profile').bearerToken(credentials[1])).status(),
    200
  )
  const current = await client.get('/api/v1/account/profile').bearerToken(credentials[1])
  assert.deepEqual(
    Object.keys((current.body() as unknown as { data: Record<string, unknown> }).data).sort(),
    ['active', 'email', 'hasPassword', 'id', 'unverifiedEmail']
  )
  assert.lengthOf(await db.from('auth_access_tokens').where('tokenable_id', user.id), 1)
})

test('password change revokes every bearer token for the account', async ({ client, assert }) => {
  if (process.env.ACCOUNT_KIT_AUTH_STRATEGY === 'session') return
  const user = await User.create({
    fullName: 'Multi Token User',
    email: `multi-token-${randomUUID()}@example.test`,
    password: 'OriginalPass123!',
  })
  const tokens: string[] = []
  for (let index = 0; index < 2; index++) {
    const login = await client
      .post('/api/v1/auth/login')
      .json({ email: user.email, password: 'OriginalPass123!' })
    assert.equal(login.status(), 200)
    tokens.push((login.body() as unknown as { data: { token: string } }).data.token)
  }
  const change = await client.post('/api/v1/account/password').bearerToken(tokens[0]).json({
    currentPassword: 'OriginalPass123!',
    newPassword: 'ReplacementPass123!',
    newPasswordConfirmation: 'ReplacementPass123!',
  })
  assert.equal(change.status(), 200)
  for (const token of tokens) {
    assert.equal((await client.get('/api/v1/account/profile').bearerToken(token)).status(), 401)
  }
  assert.lengthOf(await db.from('auth_access_tokens').where('tokenable_id', user.id), 0)
})

test('account errors use stable JSON and JSON:API envelopes while Vine errors retain 422', async ({
  client,
  assert,
}) => {
  if (process.env.ACCOUNT_KIT_AUTH_STRATEGY === 'session') return
  const email = `unknown-token-${randomUUID()}@example.test`
  const rejected = await client
    .post('/api/v1/auth/login')
    .json({ email, password: 'WrongPass123!' })
  assert.equal(rejected.status(), 401)
  assert.deepEqual(rejected.body(), {
    errors: [{ code: 'E_ACCOUNT_KIT_INVALID_CREDENTIALS', message: 'Account request rejected' }],
  })
  const jsonApi = await client
    .post('/api/v1/auth/login')
    .header('accept', 'application/vnd.api+json')
    .json({ email, password: 'WrongPass123!' })
  assert.equal(jsonApi.status(), 401)
  assert.include(jsonApi.header('content-type'), 'application/vnd.api+json')
  assert.deepEqual(jsonApi.body(), {
    errors: [{ code: 'E_ACCOUNT_KIT_INVALID_CREDENTIALS', title: 'Account request rejected' }],
  })
  const excluded = await client
    .post('/api/v1/auth/login')
    .header('accept', 'application/json, application/vnd.api+json;q=0')
    .json({ email, password: 'WrongPass123!' })
  assert.equal(excluded.status(), 401)
  assert.notInclude(excluded.header('content-type'), 'application/vnd.api+json')
  assert.deepEqual(excluded.body(), {
    errors: [{ code: 'E_ACCOUNT_KIT_INVALID_CREDENTIALS', message: 'Account request rejected' }],
  })
  const wildcard = await client
    .post('/api/v1/auth/login')
    .header('accept', 'application/*;q=1, application/vnd.api+json;q=0.5')
    .json({ email, password: 'WrongPass123!' })
  assert.equal(wildcard.status(), 401)
  assert.notInclude(wildcard.header('content-type'), 'application/vnd.api+json')
  assert.deepEqual(wildcard.body(), {
    errors: [{ code: 'E_ACCOUNT_KIT_INVALID_CREDENTIALS', message: 'Account request rejected' }],
  })
  const validation = await client
    .post('/api/v1/auth/login')
    .json({ email: 'invalid', password: '' })
  assert.equal(validation.status(), 422)
  assert.property(
    (validation.body() as unknown as { errors: Array<Record<string, unknown>> }).errors[0],
    'rule'
  )
})

test('bad login reveals one response for absent, wrong, restricted, and passwordless accounts', async ({
  client,
  assert,
}) => {
  if (process.env.ACCOUNT_KIT_AUTH_STRATEGY === 'session') return
  const wrong = await User.create({
    fullName: 'Wrong Password User',
    email: `wrong-login-${randomUUID()}@example.test`,
    password: 'CorrectPass123!',
  })
  const restricted = await User.create({
    fullName: 'Restricted User',
    email: `restricted-login-${randomUUID()}@example.test`,
    password: 'CorrectPass123!',
  })
  await db.table('role_assignments').insert({ user_id: restricted.id, role: 'disabled' })
  const passwordless = await User.create({
    fullName: 'Passwordless User',
    email: `passwordless-login-${randomUUID()}@example.test`,
    password: null,
  })
  const attempts = [
    { email: `absent-${randomUUID()}@example.test`, password: 'WrongPass123!' },
    { email: wrong.email, password: 'WrongPass123!' },
    { email: restricted.email, password: 'CorrectPass123!' },
    { email: passwordless.email, password: 'WrongPass123!' },
  ]
  const responses: unknown[] = []
  for (const attempt of attempts) {
    const response = await client.post('/api/v1/auth/login').json(attempt)
    assert.equal(response.status(), 401)
    responses.push(response.body())
  }
  for (const response of responses.slice(1)) assert.deepEqual(response, responses[0])
})

test('the existing token guard rejects an expired bearer token', async ({ client, assert }) => {
  if (process.env.ACCOUNT_KIT_AUTH_STRATEGY === 'session') return
  const user = await User.create({
    fullName: 'Expired Token User',
    email: `expired-token-${randomUUID()}@example.test`,
    password: 'OriginalPass123!',
  })
  const token = await User.accessTokens.create(user, ['profile:read'], { expiresIn: '1h' })
  const value = token.value!.release()
  assert.equal((await client.get('/api/v1/account/profile').bearerToken(value)).status(), 200)
  await db
    .from('auth_access_tokens')
    .where('tokenable_id', user.id)
    .update({ expires_at: new Date(0) })
  assert.equal((await client.get('/api/v1/account/profile').bearerToken(value)).status(), 401)
})

test('a limited inactive token cannot reach a verified account route', async ({
  client,
  assert,
}) => {
  if (process.env.ACCOUNT_KIT_AUTH_STRATEGY === 'session') return
  const user = await User.create({
    fullName: 'Inactive Token User',
    email: `inactive-token-${randomUUID()}@example.test`,
    password: 'OriginalPass123!',
  })
  user.unverifiedEmail = user.email
  await user.save()
  const token = (await User.accessTokens.create(user)).value!.release()
  const profile = await client.get('/api/v1/account/profile').bearerToken(token)
  assert.equal(profile.status(), 200)
  assert.isFalse((profile.body() as unknown as { data: { active: boolean } }).data.active)
  const restricted = await client.get('/api/v1/account/invitations').bearerToken(token)
  assert.equal(restricted.status(), 403)
  assert.equal(
    (restricted.body() as unknown as { errors: [{ code: string }] }).errors[0].code,
    'unverified_email'
  )
})

test('profile writes accept only configured fields and preserve pending-email rules', async ({
  client,
  assert,
}) => {
  if (process.env.ACCOUNT_KIT_AUTH_STRATEGY === 'session') return
  const user = await User.create({
    fullName: 'Original Name',
    email: `profile-write-${randomUUID()}@example.test`,
    password: 'OriginalPass123!',
  })
  const originalEmail = user.email
  const token = (await User.accessTokens.create(user)).value!.release()
  const update = await client.patch('/api/v1/account/profile').bearerToken(token).json({
    currentPassword: 'OriginalPass123!',
    fullName: 'Updated Name',
    isAdmin: true,
  })
  assert.equal(update.status(), 200)
  await user.refresh()
  assert.equal(user.fullName, 'Updated Name')
  const pendingEmail = `pending-profile-${randomUUID()}@example.test`
  const change = await client.patch('/api/v1/account/profile').bearerToken(token).json({
    currentPassword: 'OriginalPass123!',
    email: pendingEmail,
  })
  assert.equal(change.status(), 200)
  await user.refresh()
  assert.equal(user.email, originalEmail)
  assert.equal(user.unverifiedEmail, pendingEmail)
  const cancel = await client.patch('/api/v1/account/profile').bearerToken(token).json({
    currentPassword: 'OriginalPass123!',
    email: originalEmail,
  })
  assert.equal(cancel.status(), 200)
  await user.refresh()
  assert.isNull(user.unverifiedEmail)
})

test('an inactive email correction succeeds while revoking the old bearer credential', async ({
  client,
  assert,
}) => {
  if (process.env.ACCOUNT_KIT_AUTH_STRATEGY === 'session') return
  const email = `inactive-correction-${randomUUID()}@example.test`
  const user = await User.create({
    fullName: 'Inactive Correction',
    email,
    unverifiedEmail: email,
    password: 'OriginalPass123!',
  })
  const token = (await User.accessTokens.create(user)).value!.release()
  const correction = `corrected-${randomUUID()}@example.test`
  const response = await client.patch('/api/v1/account/profile').bearerToken(token).json({
    currentPassword: 'OriginalPass123!',
    email: correction,
  })
  assert.equal(response.status(), 200)
  assert.equal((response.body() as { data: { email: string } }).data.email, correction)
  await user.refresh()
  assert.equal(user.email, correction)
  assert.equal(user.unverifiedEmail, correction)
  assert.equal((await client.get('/api/v1/account/profile').bearerToken(token)).status(), 401)
})

test('verification GET inspects without consuming and POST completes once', async ({
  client,
  assert,
}) => {
  if (process.env.ACCOUNT_KIT_AUTH_STRATEGY === 'session') return
  const user = await User.create({
    fullName: 'Verification Link User',
    email: `verification-link-${randomUUID()}@example.test`,
    unverifiedEmail: `verification-link-${randomUUID()}@example.test`,
    password: 'OriginalPass123!',
  })
  user.unverifiedEmail = user.email
  await user.save()
  const oldToken = (await User.accessTokens.create(user)).value!.release()
  const kit = await app.container.make(AccountKit)
  await kit.emailVerification.send({ userId: user.id })
  const notice = notifications.events.findLast(
    (event) => event.kind === 'verification' && event.recipient === user.email
  )!
  const path = `/api/v1/auth/email-verification/${encodeURIComponent(proofFrom(notice.value))}`
  for (let index = 0; index < 2; index++) {
    const inspect = await client.get(path)
    assert.equal(inspect.status(), 200)
    assert.equal(inspect.header('cache-control'), 'no-store')
    assert.equal(inspect.header('referrer-policy'), 'no-referrer')
    await user.refresh()
    assert.equal(user.unverifiedEmail, user.email)
  }
  const complete = await client.post(path).json({
    password: 'ReplacementPass123!',
    passwordConfirmation: 'ReplacementPass123!',
  })
  assert.equal(complete.status(), 200)
  await user.refresh()
  assert.isNull(user.unverifiedEmail)
  assert.equal((await client.get('/api/v1/account/profile').bearerToken(oldToken)).status(), 401)
  assert.equal(
    (
      await client
        .post('/api/v1/auth/login')
        .json({ email: user.email, password: 'OriginalPass123!' })
    ).status(),
    401
  )
  assert.equal(
    (
      await client
        .post('/api/v1/auth/login')
        .json({ email: user.email, password: 'ReplacementPass123!' })
    ).status(),
    200
  )
  const replay = await client.post(path).json({
    password: 'ReplacementPass123!',
    passwordConfirmation: 'ReplacementPass123!',
  })
  assert.equal(replay.status(), 400)
  assert.deepEqual(replay.body(), {
    errors: [{ code: 'E_INVALID_EMAIL_TOKEN', message: 'This link is invalid or expired.' }],
  })
  const spentInspect = await client.get(path)
  assert.equal(spentInspect.status(), 400)
  assert.equal(spentInspect.header('cache-control'), 'no-store')
  const jsonApiProof = await client.get(path).header('accept', 'application/vnd.api+json')
  assert.equal(jsonApiProof.status(), 400)
  assert.deepEqual(jsonApiProof.body(), {
    errors: [{ code: 'E_INVALID_EMAIL_TOKEN', title: 'This link is invalid or expired.' }],
  })
})

test('malformed proof submission still receives private-cache and referrer headers', async ({
  client,
  assert,
}) => {
  const malformed = await client
    .post('/api/v1/auth/email-verification/malformed-proof')
    .unsafeJson('{"password":')
  assert.equal(malformed.status(), 400)
  assert.equal(malformed.header('cache-control'), 'no-store')
  assert.equal(malformed.header('referrer-policy'), 'no-referrer')
})
