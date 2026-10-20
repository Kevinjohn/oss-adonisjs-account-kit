import { randomUUID } from 'node:crypto'
import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import User from '#models/user'
import { setSocialFixture } from '#tests/helpers/social_provider_fixture'
import { notifications } from '#services/account_kit_notifications'
import {
  pkceChallenge as challenge,
  pkceVerifier as verifier,
} from '#services/social_browser_transaction'
import { ACCESS_TOKENS_ONLY, isSessionStrategy } from '#tests/helpers/strategy'

const stateFrom = (url: string) => new URL(url).searchParams.get('state')!

type Body = Record<string, unknown>
const body = (response: { body(): unknown }) => response.body() as Body
const continuationFrom = (response: { body(): unknown }): string => {
  const continuation = body(response).continuation
  if (typeof continuation !== 'string') throw new Error('Expected social continuation')
  return continuation
}

test('social request input is rejected by VineJS validators', async ({ client, assert }) => {
  const vineFields = (response: { body(): unknown }) =>
    (response.body() as { errors: Array<{ field: string; rule: string }> }).errors.map(
      (error) => error.field
    )
  const noChallenge = await client.post('/api/v1/auth/oauth/google/redirect').json({})
  assert.equal(noChallenge.status(), 422)
  assert.deepEqual(vineFields(noChallenge), ['clientChallenge'])
  const badIntent = await client
    .post('/api/v1/auth/oauth/google/redirect')
    .json({ intent: 'unknown', clientChallenge: challenge(verifier()) } as never)
  assert.equal(badIntent.status(), 422)
  assert.deepEqual(vineFields(badIntent), ['intent'])
  const noVerifier = await client
    .post('/api/v1/auth/oauth/token')
    .json({ code: 'handoff' } as never)
  assert.equal(noVerifier.status(), 422)
  assert.deepEqual(vineFields(noVerifier), ['verifier'])
}).skip(isSessionStrategy, ACCESS_TOKENS_ONLY)

test('token client completes a verified social registration through one PKCE exchange', async ({
  client,
  assert,
}) => {
  const heldVerifier = verifier()
  const started = await client.post('/api/v1/auth/oauth/google/redirect').json({
    intent: 'login',
    clientChallenge: challenge(heldVerifier),
  })
  assert.equal(started.status(), 200, JSON.stringify(started.body()))
  const authorizationUrl = body(started).authorizationUrl as string
  const state = stateFrom(authorizationUrl)
  const email = `social-${randomUUID()}@example.test`
  const subject = randomUUID()
  setSocialFixture(state, 'google', 'provider-code', {
    subject,
    email,
    emailVerified: true,
    name: 'Untrusted Provider Name',
  })
  const callback = await client.post('/api/v1/auth/oauth/google/callback').json({
    state,
    code: 'provider-code',
    intent: 'login',
  })
  assert.equal(callback.status(), 200, JSON.stringify(callback.body()))
  assert.equal(body(callback).status, 'new')
  const continuation = continuationFrom(callback)
  assert.notProperty(body(callback), 'token')
  assert.lengthOf(await db.from(User.table).where('email', email), 0)

  for (const fullName of ['   ', 'A'.repeat(101)]) {
    const invalid = await client.post('/api/v1/auth/oauth/registration').json({
      continuation,
      fullName,
    })
    assert.equal(invalid.status(), 422, JSON.stringify(invalid.body()))
    assert.include(JSON.stringify(invalid.body()), 'fullName')
    assert.lengthOf(await db.from(User.table).where('email', email), 0)
  }

  const completed = await client.post('/api/v1/auth/oauth/registration').json({
    continuation,
    fullName: '  Confirmed Name  ',
  })
  assert.equal(completed.status(), 200, JSON.stringify(completed.body()))
  assert.equal(body(completed).status, 'new')
  const handoffCode = body(completed).handoffCode as string
  assert.isString(handoffCode)
  assert.notProperty(body(completed), 'token')

  const wrongClient = await client.post('/api/v1/auth/oauth/token').json({
    code: handoffCode,
    verifier: verifier(),
  })
  assert.equal(wrongClient.status(), 400)
  const redeemed = await client.post('/api/v1/auth/oauth/token').json({
    code: handoffCode,
    verifier: heldVerifier,
  })
  assert.equal(redeemed.status(), 200, JSON.stringify(redeemed.body()))
  const redeemedData = body(redeemed).data as { user: object; token: string }
  assert.isString(redeemedData.token)
  assert.deepEqual(Object.keys(redeemedData.user).sort(), [
    'createdAt',
    'email',
    'fullName',
    'id',
    'initials',
    'updatedAt',
  ])
  const methodsAfterSocial = await client
    .get('/api/v1/account/methods')
    .bearerToken(redeemedData.token)
    .cookie('account_kit_last_method', redeemed.cookie('account_kit_last_method')!.value)
  assert.equal(body(methodsAfterSocial).lastUsedMethod, 'google')
  const unsupportedHint = await client
    .get('/api/v1/account/methods')
    .bearerToken(redeemedData.token)
    .cookie('account_kit_last_method', 'unsupported-method')
  assert.equal(body(unsupportedHint).lastUsedMethod, null)
  const unavailablePasswordHint = await client
    .get('/api/v1/account/methods')
    .bearerToken(redeemedData.token)
    .cookie('account_kit_last_method', 'password')
  assert.equal(body(unavailablePasswordHint).lastUsedMethod, null)
  const profile = await client.get('/api/v1/account/profile').bearerToken(redeemedData.token)
  assert.equal(profile.status(), 200)
  const replay = await client.post('/api/v1/auth/oauth/token').json({
    code: handoffCode,
    verifier: heldVerifier,
  })
  assert.equal(replay.status(), 400)
  const created = await User.findByOrFail('email', email)
  assert.equal(created.fullName, 'Confirmed Name')
  assert.isNull(created.password)

  const reauth = await client
    .post('/api/v1/auth/oauth/google/redirect')
    .bearerToken(redeemedData.token)
    .json({
      intent: 'reauth',
      purpose: 'social_unlink',
      clientChallenge: challenge(verifier()),
    })
  assert.equal(reauth.status(), 403)
  assert.equal(
    (body(reauth).errors as { code: string }[])[0].code,
    'E_ACCOUNT_KIT_SOCIAL_PROOF_INVALID'
  )
  const relation = await db.from('social_identities').where('user_id', created.id).first()
  const withoutProof = await client
    .delete(`/api/v1/account/social/${relation.id}`)
    .bearerToken(redeemedData.token)
    .json({ proof: verifier() })
  assert.equal(withoutProof.status(), 403)
  assert.lengthOf(await db.from('social_identities').where('user_id', created.id), 1)

  const recovery = await client.post('/api/v1/auth/password-reset').json({ email })
  assert.equal(recovery.status(), 202)
  const recoveryNotice = notifications.events.findLast(
    (event) => event.kind === 'recovery' && event.recipient === email
  )
  assert.isDefined(recoveryNotice)
  const reset = await client.post(new URL(recoveryNotice!.value).pathname).json({
    password: 'FirstPassword123!',
    passwordConfirmation: 'FirstPassword123!',
  })
  assert.equal(reset.status(), 202, JSON.stringify(reset.body()))
  const passwordLogin = await client.post('/api/v1/auth/login').json({
    email,
    password: 'FirstPassword123!',
  })
  assert.equal(passwordLogin.status(), 200)
  const passwordToken = (body(passwordLogin).data as { token: string }).token
  const methodsAfterPassword = await client
    .get('/api/v1/account/methods')
    .bearerToken(passwordToken)
    .cookie('account_kit_last_method', passwordLogin.cookie('account_kit_last_method')!.value)
  assert.equal(body(methodsAfterPassword).lastUsedMethod, 'password')
  const passwordProof = await client
    .post('/api/v1/account/social/proof')
    .bearerToken(passwordToken)
    .json({ password: 'FirstPassword123!', purpose: 'social_unlink' })
  assert.equal(passwordProof.status(), 200)
  const unlinked = await client
    .delete(`/api/v1/account/social/${relation.id}`)
    .bearerToken(passwordToken)
    .json({ proof: body(passwordProof).proof as string })
  assert.equal(unlinked.status(), 204)
  assert.lengthOf(await db.from('social_identities').where('user_id', created.id), 0)
}).skip(isSessionStrategy, ACCESS_TOKENS_ONLY)

test('matching email requires linking proof and never signs into that account', async ({
  client,
  assert,
}) => {
  const user = await User.create({
    fullName: 'Existing Local User',
    email: `existing-social-${randomUUID()}@example.test`,
    password: 'OriginalPass123!',
  })
  const heldVerifier = verifier()
  const started = await client.post('/api/v1/auth/oauth/github/redirect').json({
    intent: 'login',
    clientChallenge: challenge(heldVerifier),
  })
  const state = stateFrom(body(started).authorizationUrl as string)
  setSocialFixture(state, 'github', 'matching-code', {
    subject: randomUUID(),
    email: user.email,
    emailVerified: true,
  })
  const callback = await client.post('/api/v1/auth/oauth/github/callback').json({
    state,
    code: 'matching-code',
  })
  assert.equal(callback.status(), 200, JSON.stringify(callback.body()))
  assert.deepEqual(body(callback), { status: 'link_required' })
  assert.lengthOf(await db.from('social_identities').where('user_id', user.id), 0)
}).skip(isSessionStrategy, ACCESS_TOKENS_ONLY)

test('missing provider email stays inactive until local proof and fresh provider confirmation', async ({
  client,
  assert,
}) => {
  const subject = randomUUID()
  const firstVerifier = verifier()
  const started = await client.post('/api/v1/auth/oauth/github/redirect').json({
    intent: 'login',
    clientChallenge: challenge(firstVerifier),
  })
  const state = stateFrom(body(started).authorizationUrl as string)
  setSocialFixture(state, 'github', 'missing-email-code', {
    subject,
    email: null,
    emailVerified: false,
  })
  const callback = await client.post('/api/v1/auth/oauth/github/callback').json({
    state,
    code: 'missing-email-code',
  })
  assert.equal(callback.status(), 200)
  const email = `collected-social-${randomUUID()}@example.test`
  const continuation = continuationFrom(callback)
  const complete = await client.post('/api/v1/auth/oauth/registration').json({
    continuation,
    email,
    fullName: 'Collected Social User',
  })
  assert.equal(complete.status(), 200, JSON.stringify(complete.body()))
  assert.equal(body(complete).emailVerificationRequired, true)
  assert.notProperty(body(complete), 'handoffCode')
  const pending = await db.from('social_identities').where('provider_user_id', subject).first()
  assert.isNull(pending.confirmed_at)
  const notice = notifications.events.findLast(
    (event) => event.kind === 'verification' && event.recipient === email
  )
  assert.isDefined(notice)
  assert.include(notice!.value, '/api/v1/auth/social-verification/')
  const entry = await client.get(new URL(notice!.value).pathname)
  assert.equal(entry.status(), 200)
  const verificationToken = body(entry).verificationToken as string
  const confirmationVerifier = verifier()
  const confirmation = await client.post('/api/v1/auth/oauth/github/confirm').json({
    verificationToken,
    clientChallenge: challenge(confirmationVerifier),
  })
  assert.equal(confirmation.status(), 200, JSON.stringify(confirmation.body()))
  const confirmationState = stateFrom(body(confirmation).authorizationUrl as string)
  setSocialFixture(confirmationState, 'github', 'confirmation-code', {
    subject,
    email: null,
    emailVerified: false,
  })
  const confirmed = await client.post('/api/v1/auth/oauth/github/callback').json({
    state: confirmationState,
    code: 'confirmation-code',
  })
  assert.equal(confirmed.status(), 200, JSON.stringify(confirmed.body()))
  assert.equal(body(confirmed).status, 'linked')
  const redeemed = await client.post('/api/v1/auth/oauth/token').json({
    code: body(confirmed).handoffCode as string,
    verifier: confirmationVerifier,
  })
  assert.equal(redeemed.status(), 200, JSON.stringify(redeemed.body()))
  const active = await db.from('social_identities').where('provider_user_id', subject).first()
  assert.isNotNull(active.confirmed_at)
}).skip(isSessionStrategy, ACCESS_TOKENS_ONLY)

test('token link and unlink use the authenticated actor and purpose-bound proof', async ({
  client,
  assert,
}) => {
  const user = await User.create({
    fullName: 'Social Linking User',
    email: `link-social-${randomUUID()}@example.test`,
    password: 'OriginalPass123!',
  })
  const login = await client.post('/api/v1/auth/login').json({
    email: user.email,
    password: 'OriginalPass123!',
  })
  const token = (body(login).data as { token: string }).token
  const unauthorized = await client.post('/api/v1/auth/oauth/google/redirect').json({
    intent: 'link',
    clientChallenge: challenge(verifier()),
  })
  assert.equal(unauthorized.status(), 403)
  assert.equal(unauthorized.header('cache-control'), 'no-store')
  assert.equal(unauthorized.header('referrer-policy'), 'no-referrer')
  const proofResponse = await client
    .post('/api/v1/account/social/proof')
    .bearerToken(token)
    .json({ password: 'OriginalPass123!', purpose: 'social_link' })
  assert.equal(proofResponse.status(), 200)
  const heldVerifier = verifier()
  const started = await client
    .post('/api/v1/auth/oauth/google/redirect')
    .bearerToken(token)
    .json({
      intent: 'link',
      clientChallenge: challenge(heldVerifier),
      proof: body(proofResponse).proof,
    })
  assert.equal(started.status(), 200, JSON.stringify(started.body()))
  const state = stateFrom(body(started).authorizationUrl as string)
  setSocialFixture(state, 'google', 'link-code', {
    subject: randomUUID(),
    email: 'changed-provider-email@example.test',
    emailVerified: false,
  })
  const withoutActor = await client.post('/api/v1/auth/oauth/google/callback').json({
    state,
    code: 'link-code',
  })
  assert.equal(withoutActor.status(), 400)
  const otherUser = await User.create({
    fullName: 'Wrong Linking Actor',
    email: `wrong-actor-${randomUUID()}@example.test`,
    password: 'OtherPass123!',
  })
  const otherLogin = await client.post('/api/v1/auth/login').json({
    email: otherUser.email,
    password: 'OtherPass123!',
  })
  const otherToken = (body(otherLogin).data as { token: string }).token
  const actorProof = await client
    .post('/api/v1/account/social/proof')
    .bearerToken(token)
    .json({ password: 'OriginalPass123!', purpose: 'social_link' })
  assert.equal(actorProof.status(), 200)
  const actorStart = await client
    .post('/api/v1/auth/oauth/google/redirect')
    .bearerToken(token)
    .json({
      intent: 'link',
      clientChallenge: challenge(verifier()),
      proof: body(actorProof).proof,
    })
  assert.equal(actorStart.status(), 200)
  const actorState = stateFrom(body(actorStart).authorizationUrl as string)
  const actorSubject = randomUUID()
  setSocialFixture(actorState, 'google', 'actor-code', {
    subject: actorSubject,
    email: 'changed-provider-email@example.test',
    emailVerified: false,
  })
  const wrongActor = await client
    .post('/api/v1/auth/oauth/google/callback')
    .bearerToken(otherToken)
    .json({ state: actorState, code: 'actor-code' })
  assert.equal(wrongActor.status(), 400)
  assert.equal(
    (body(wrongActor).errors as { code: string }[])[0].code,
    'E_ACCOUNT_KIT_SOCIAL_TRANSACTION_INVALID'
  )
  assert.lengthOf(await db.from('social_identities').where('user_id', otherUser.id), 0)
  assert.lengthOf(await db.from('social_identities').where('user_id', user.id), 0)
  setSocialFixture(actorState, 'google', 'actor-code', {
    subject: actorSubject,
    email: 'changed-provider-email@example.test',
    emailVerified: false,
  })
  const callback = await client
    .post('/api/v1/auth/oauth/google/callback')
    .bearerToken(token)
    .json({ state: actorState, code: 'actor-code' })
  assert.equal(callback.status(), 200, JSON.stringify(callback.body()))
  assert.equal(body(callback).status, 'linked')
  const methods = await client.get('/api/v1/account/methods').bearerToken(token)
  assert.equal(methods.status(), 200)
  assert.equal(body(methods).password, true)
  assert.deepEqual(body(methods).configuredProviders, ['google', 'github'])
  const hintedMethods = await client
    .get('/api/v1/account/methods')
    .bearerToken(token)
    .cookie('account_kit_last_method', login.cookie('account_kit_last_method')!.value)
  assert.equal(body(hintedMethods).lastUsedMethod, 'password')
  const social = body(methods).social as { id: number; provider: string }[]
  assert.lengthOf(social, 1)
  assert.equal(social[0].provider, 'google')

  const wrongPurposeProof = await client
    .post('/api/v1/account/social/proof')
    .bearerToken(token)
    .json({ password: 'OriginalPass123!', purpose: 'email_change' })
  assert.equal(wrongPurposeProof.status(), 200)
  const wrongProof = await client
    .delete(`/api/v1/account/social/${social[0].id}`)
    .bearerToken(token)
    .json({ proof: body(wrongPurposeProof).proof })
  assert.equal(wrongProof.status(), 403)
  const unlinkProof = await client
    .post('/api/v1/account/social/proof')
    .bearerToken(token)
    .json({ password: 'OriginalPass123!', purpose: 'social_unlink' })
  const unlinked = await client
    .delete(`/api/v1/account/social/${social[0].id}`)
    .bearerToken(token)
    .json({ proof: body(unlinkProof).proof })
  assert.equal(unlinked.status(), 204, JSON.stringify(unlinked.body()))
  assert.lengthOf(await db.from('social_identities').where('user_id', user.id), 0)
}).skip(isSessionStrategy, ACCESS_TOKENS_ONLY)

test('password signup records the visitor hint only after credential establishment', async ({
  client,
  assert,
}) => {
  notifications.reset()
  const signup = await client
    .post('/api/v1/auth/signup')
    .cookie('account_kit_last_method', 'google')
    .json({
      fullName: 'Password Signup Hint',
      email: `hint-signup-${randomUUID()}@example.test`,
      password: 'SignupPassword123!',
      passwordConfirmation: 'SignupPassword123!',
    })
  assert.equal(signup.status(), 200, JSON.stringify(signup.body()))
  const hint = signup.cookie('account_kit_last_method')?.value
  assert.isString(hint)
  const token = (body(signup).data as { token: string }).token
  const methods = await client
    .get('/api/v1/account/methods')
    .bearerToken(token)
    .cookie('account_kit_last_method', hint!)
  assert.equal(methods.status(), 200)
  assert.equal(body(methods).lastUsedMethod, 'password')

  notifications.failVerification = true
  try {
    const committedWithoutCredential = await client.post('/api/v1/auth/signup').json({
      fullName: 'Signup Delivery Failure',
      email: `hint-undelivered-${randomUUID()}@example.test`,
      password: 'SignupPassword123!',
      passwordConfirmation: 'SignupPassword123!',
    })
    assert.equal(committedWithoutCredential.status(), 202)
    assert.isUndefined(committedWithoutCredential.cookie('account_kit_last_method'))
  } finally {
    notifications.failVerification = false
  }
}).skip(isSessionStrategy, ACCESS_TOKENS_ONLY)

test('social persistence failure has a generic public response and correlation ID', async ({
  client,
  assert,
}) => {
  await db.connection().schema.renameTable('social_transactions', 'social_transactions_unavailable')
  try {
    for (const accept of ['application/json', 'application/vnd.api+json']) {
      const response = await client
        .post('/api/v1/auth/oauth/google/redirect')
        .header('accept', accept)
        .json({ intent: 'login', clientChallenge: challenge(verifier()) })
      assert.equal(response.status(), 500)
      assert.include(response.header('content-type'), accept)
      assert.deepEqual(response.body(), {
        errors: [
          accept === 'application/json'
            ? { code: 'E_ACCOUNT_KIT_SOCIAL_UNAVAILABLE', message: 'Account operation unavailable' }
            : { code: 'E_ACCOUNT_KIT_SOCIAL_UNAVAILABLE', title: 'Account operation unavailable' },
        ],
      })
      assert.notInclude(JSON.stringify(response.body()), 'social_transactions')
      assert.isString(response.header('x-correlation-id'))
      assert.equal(response.header('cache-control'), 'no-store')
      assert.equal(response.header('referrer-policy'), 'no-referrer')
    }
  } finally {
    await db
      .connection()
      .schema.renameTable('social_transactions_unavailable', 'social_transactions')
  }
}).skip(isSessionStrategy, ACCESS_TOKENS_ONLY)

test('social starts and password proofs have explicit HTTP abuse budgets', async ({
  client,
  assert,
}) => {
  let limitedStart = false
  for (let attempt = 0; attempt < 25; attempt++) {
    const response = await client.post('/api/v1/auth/oauth/unknown/redirect').json({
      intent: 'login',
      clientChallenge: challenge(verifier()),
    })
    if (response.status() === 429) {
      limitedStart = true
      assert.isString(response.header('retry-after'))
      assert.equal(response.header('cache-control'), 'no-store')
      break
    }
  }
  assert.isTrue(limitedStart)

  const user = await User.create({
    fullName: 'Proof Budget User',
    email: `proof-budget-${randomUUID()}@example.test`,
    password: 'OriginalPass123!',
  })
  const login = await client.post('/api/v1/auth/login').json({
    email: user.email,
    password: 'OriginalPass123!',
  })
  assert.equal(login.status(), 200)
  const token = (body(login).data as { token: string }).token
  for (let attempt = 0; attempt < 5; attempt++) {
    const rejected = await client
      .post('/api/v1/account/social/proof')
      .bearerToken(token)
      .json({ password: 'WrongPass123!', purpose: 'social_link' })
    assert.isBelow(rejected.status(), 500)
  }
  const limitedProof = await client
    .post('/api/v1/account/social/proof')
    .bearerToken(token)
    .json({ password: 'WrongPass123!', purpose: 'social_link' })
  assert.equal(limitedProof.status(), 429)
  assert.isString(limitedProof.header('retry-after'))
}).skip(isSessionStrategy, ACCESS_TOKENS_ONLY)
