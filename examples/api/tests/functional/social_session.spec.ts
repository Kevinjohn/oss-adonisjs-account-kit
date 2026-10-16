import { randomUUID } from 'node:crypto'
import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import User from '#models/user'
import { setSocialFixture } from '#services/social_provider_fixture'

function rawCookies(response: { header(name: string): string | string[] | undefined }): string {
  const values = response.header('set-cookie')
  return (Array.isArray(values) ? values : [values])
    .filter(Boolean)
    .map((value) => String(value).split(';', 1)[0])
    .join('; ')
}

test('password signup records the visitor method after the web guard is established', async ({
  client,
  assert,
}) => {
  if (process.env.ACCOUNT_KIT_AUTH_STRATEGY !== 'session') return
  const bootstrap = await client.get('/api/v1/auth/csrf')
  const signup = await client
    .post('/api/v1/auth/signup')
    .header('cookie', rawCookies(bootstrap))
    .header('x-csrf-token', (bootstrap.body() as { csrfToken: string }).csrfToken)
    .json({
      fullName: 'Session Signup Hint',
      email: `session-signup-hint-${randomUUID()}@example.test`,
      password: 'SignupPassword123!',
      passwordConfirmation: 'SignupPassword123!',
    })
  assert.equal(signup.status(), 200, JSON.stringify(signup.body()))
  const methods = await client.get('/api/v1/account/methods').header('cookie', rawCookies(signup))
  assert.equal(methods.status(), 200)
  assert.equal((methods.body() as { lastUsedMethod: string }).lastUsedMethod, 'password')
})

test('browser session keeps PKCE verifier server-side and establishes the existing web guard', async ({
  client,
  assert,
}) => {
  if (process.env.ACCOUNT_KIT_AUTH_STRATEGY !== 'session') return
  const bootstrap = await client.get('/api/v1/auth/csrf')
  assert.equal(bootstrap.status(), 200)
  const csrf = (bootstrap.body() as { csrfToken: string }).csrfToken
  const missingCsrf = await client
    .post('/api/v1/auth/oauth/google/redirect')
    .header('cookie', rawCookies(bootstrap))
    .json({ intent: 'login' })
  assert.equal(missingCsrf.status(), 403)
  assert.equal(missingCsrf.header('cache-control'), 'no-store')
  assert.equal(missingCsrf.header('referrer-policy'), 'no-referrer')
  const started = await client
    .post('/api/v1/auth/oauth/google/redirect')
    .header('cookie', rawCookies(bootstrap))
    .header('x-csrf-token', csrf)
    .json({ intent: 'login' })
  assert.equal(started.status(), 200, JSON.stringify(started.body()))
  assert.equal(started.header('cache-control'), 'no-store')
  assert.equal(started.header('referrer-policy'), 'no-referrer')
  const url = (started.body() as { authorizationUrl: string }).authorizationUrl
  const state = new URL(url).searchParams.get('state')!
  const email = `browser-social-${randomUUID()}@example.test`
  setSocialFixture(state, 'google', 'session-code', {
    subject: randomUUID(),
    email,
    emailVerified: true,
  })
  const otherBootstrap = await client.get('/api/v1/auth/csrf')
  const otherCookie = rawCookies(otherBootstrap)
  const otherCsrf = (otherBootstrap.body() as { csrfToken: string }).csrfToken
  const wrongSession = await client
    .get(`/api/v1/auth/oauth/google/callback?state=${encodeURIComponent(state)}&code=session-code`)
    .header('cookie', otherCookie)
  assert.equal(wrongSession.status(), 422)
  const callback = await client
    .get(`/api/v1/auth/oauth/google/callback?state=${encodeURIComponent(state)}&code=session-code`)
    .header('cookie', rawCookies(started) || rawCookies(bootstrap))
  assert.equal(callback.status(), 200, JSON.stringify(callback.body()))
  const continuation = (callback.body() as { continuation: string }).continuation
  assert.isString(continuation)
  assert.notProperty(callback.body(), 'token')
  const wrongContinuation = await client
    .post('/api/v1/auth/oauth/registration')
    .header('cookie', otherCookie)
    .header('x-csrf-token', otherCsrf)
    .json({ continuation, fullName: 'Wrong Browser' })
  assert.equal(wrongContinuation.status(), 422)
  const completionCsrf = await client
    .get('/api/v1/auth/csrf')
    .header('cookie', rawCookies(callback) || rawCookies(started) || rawCookies(bootstrap))
  const complete = await client
    .post('/api/v1/auth/oauth/registration')
    .header('cookie', rawCookies(completionCsrf) || rawCookies(callback) || rawCookies(started))
    .header('x-csrf-token', (completionCsrf.body() as { csrfToken: string }).csrfToken)
    .json({ continuation, fullName: 'Browser Social User' })
  assert.equal(complete.status(), 200, JSON.stringify(complete.body()))
  assert.notProperty(complete.body(), 'handoffCode')
  assert.notProperty(complete.body(), 'token')
  const cookie = rawCookies(complete)
  assert.isNotEmpty(cookie)
  const profile = await client.get('/api/v1/account/profile').header('cookie', cookie)
  assert.equal(profile.status(), 200, JSON.stringify(profile.body()))
  const methods = await client.get('/api/v1/account/methods').header('cookie', cookie)
  assert.equal(methods.status(), 200)
  assert.equal((methods.body() as { lastUsedMethod: string }).lastUsedMethod, 'google')
  const created = await User.findByOrFail('email', email)
  assert.isNull(created.password)
})

test('browser session links and unlinks with a bound recent password proof', async ({
  client,
  assert,
}) => {
  if (process.env.ACCOUNT_KIT_AUTH_STRATEGY !== 'session') return
  const user = await User.create({
    fullName: 'Session Link User',
    email: `session-link-${randomUUID()}@example.test`,
    password: 'OriginalPass123!',
  })
  const bootstrap = await client.get('/api/v1/auth/csrf')
  const login = await client
    .post('/api/v1/auth/login')
    .header('cookie', rawCookies(bootstrap))
    .header('x-csrf-token', (bootstrap.body() as { csrfToken: string }).csrfToken)
    .json({ email: user.email, password: 'OriginalPass123!' })
  assert.equal(login.status(), 200)
  const cookie = rawCookies(login)
  const csrf = await client.get('/api/v1/auth/csrf').header('cookie', cookie)
  const proof = await client
    .post('/api/v1/account/social/proof')
    .header('cookie', cookie)
    .header('x-csrf-token', (csrf.body() as { csrfToken: string }).csrfToken)
    .json({ password: 'OriginalPass123!', purpose: 'social_link' })
  assert.equal(proof.status(), 200, JSON.stringify(proof.body()))
  const started = await client
    .post('/api/v1/auth/oauth/github/redirect')
    .header('cookie', cookie)
    .header('x-csrf-token', (csrf.body() as { csrfToken: string }).csrfToken)
    .json({ intent: 'link', proof: (proof.body() as { proof: string }).proof })
  assert.equal(started.status(), 200, JSON.stringify(started.body()))
  const state = new URL(
    (started.body() as { authorizationUrl: string }).authorizationUrl
  ).searchParams.get('state')!
  setSocialFixture(state, 'github', 'session-link-code', {
    subject: randomUUID(),
    email: 'provider-snapshot@example.test',
    emailVerified: false,
  })
  const linked = await client
    .get(`/api/v1/auth/oauth/github/callback?state=${state}&code=session-link-code`)
    .header('cookie', rawCookies(started) || cookie)
  assert.equal(linked.status(), 200, JSON.stringify(linked.body()))
  assert.equal((linked.body() as { status: string }).status, 'linked')
  const methods = await client.get('/api/v1/account/methods').header('cookie', cookie)
  assert.equal(methods.status(), 200)
  assert.equal((methods.body() as { lastUsedMethod: string }).lastUsedMethod, 'password')
  const identity = (methods.body() as { social: { id: number }[] }).social[0]
  assert.isDefined(identity)
  const unlinkProof = await client
    .post('/api/v1/account/social/proof')
    .header('cookie', cookie)
    .header('x-csrf-token', (csrf.body() as { csrfToken: string }).csrfToken)
    .json({ password: 'OriginalPass123!', purpose: 'social_unlink' })
  assert.equal(unlinkProof.status(), 200)
  const unlinked = await client
    .delete(`/api/v1/account/social/${identity.id}`)
    .header('cookie', cookie)
    .header('x-csrf-token', (csrf.body() as { csrfToken: string }).csrfToken)
    .json({ proof: (unlinkProof.body() as { proof: string }).proof })
  assert.equal(unlinked.status(), 204, JSON.stringify(unlinked.body()))
})

test('browser social link rejects a session invalidated after initiation', async ({
  client,
  assert,
}) => {
  if (process.env.ACCOUNT_KIT_AUTH_STRATEGY !== 'session') return
  const user = await User.create({
    fullName: 'Stale Session User',
    email: `stale-social-${randomUUID()}@example.test`,
    password: 'OriginalPass123!',
  })
  const bootstrap = await client.get('/api/v1/auth/csrf')
  const login = await client
    .post('/api/v1/auth/login')
    .header('cookie', rawCookies(bootstrap))
    .header('x-csrf-token', (bootstrap.body() as { csrfToken: string }).csrfToken)
    .json({ email: user.email, password: 'OriginalPass123!' })
  assert.equal(login.status(), 200)
  const cookie = rawCookies(login)
  const csrf = await client.get('/api/v1/auth/csrf').header('cookie', cookie)
  const csrfToken = (csrf.body() as { csrfToken: string }).csrfToken
  const proof = await client
    .post('/api/v1/account/social/proof')
    .header('cookie', cookie)
    .header('x-csrf-token', csrfToken)
    .json({ password: 'OriginalPass123!', purpose: 'social_link' })
  assert.equal(proof.status(), 200)
  const started = await client
    .post('/api/v1/auth/oauth/github/redirect')
    .header('cookie', cookie)
    .header('x-csrf-token', csrfToken)
    .json({ intent: 'link', proof: (proof.body() as { proof: string }).proof })
  assert.equal(started.status(), 200)
  const state = new URL(
    (started.body() as { authorizationUrl: string }).authorizationUrl
  ).searchParams.get('state')!
  setSocialFixture(state, 'github', 'stale-code', {
    subject: randomUUID(),
    email: user.email,
    emailVerified: true,
  })
  await db.from('users').where('id', user.id).update({ credentials_changed_at: new Date() })
  const callback = await client
    .get(`/api/v1/auth/oauth/github/callback?state=${state}&code=stale-code`)
    .header('cookie', rawCookies(started) || cookie)
  assert.isAtLeast(callback.status(), 400)
  assert.lengthOf(await db.from('social_identities').where('user_id', user.id), 0)
})
