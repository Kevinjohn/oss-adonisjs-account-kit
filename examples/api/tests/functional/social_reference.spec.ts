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
import { truncateDatabase } from '#tests/helpers/database'

const stateFrom = (url: string) => new URL(url).searchParams.get('state')!

type Body = Record<string, unknown>
const body = (response: { body(): unknown }) => response.body() as Body

const continuationFrom = (response: { body(): unknown }): string => {
  const continuation = body(response).continuation
  if (typeof continuation !== 'string') throw new Error('Expected social continuation')
  return continuation
}

test.group('Social reference', (group) => {
  group.each.setup(truncateDatabase)

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
})
