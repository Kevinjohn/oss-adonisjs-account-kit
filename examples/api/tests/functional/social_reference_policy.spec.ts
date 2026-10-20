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
test.group('Social reference', (group) => {
  group.each.setup(truncateDatabase)

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
    await db
      .connection()
      .schema.renameTable('social_transactions', 'social_transactions_unavailable')
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
              ? {
                  code: 'E_ACCOUNT_KIT_SOCIAL_UNAVAILABLE',
                  message: 'Account operation unavailable',
                }
              : {
                  code: 'E_ACCOUNT_KIT_SOCIAL_UNAVAILABLE',
                  title: 'Account operation unavailable',
                },
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
})
