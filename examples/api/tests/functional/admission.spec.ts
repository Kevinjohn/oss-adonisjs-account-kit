/* eslint-disable @unicorn/no-await-expression-member -- Inline awaited requests keep each assertion tied to the HTTP operation it verifies. */

import { randomUUID } from 'node:crypto'
import { test } from '@japa/runner'
import type { ApiClient, ApiRequest, ApiResponse } from '@japa/api-client'
import { DateTime } from 'luxon'
import db from '@adonisjs/lucid/services/db'
import User from '#models/user'
import { notifications } from '#services/account_kit_notifications'
import {
  pkceChallenge as challenge,
  pkceVerifier as verifier,
} from '#services/social_browser_transaction'
import { grantAdmission, grantAdmittedOwner } from '#tests/helpers/admission'
import { cookies } from '#tests/helpers/cookies'
import { truncateDatabase } from '#tests/helpers/database'
import { tokenFrom } from '#tests/helpers/link_tokens'
import { setSocialFixture } from '#tests/helpers/social_provider_fixture'
import { isSessionStrategy } from '#tests/helpers/strategy'

/** A signed-in or anonymous caller in either strategy. */
interface Credential {
  bearer?: string
  cookie?: string
  csrf?: string
}

interface Decision {
  admitted: boolean
  requirements: {
    domain?: { met: boolean; reason?: string }
    invitation?: { met: boolean }
    approval?: { met: boolean; status: string; requested: boolean }
  }
}

const password = 'AdmissionPass123!'
const domains = process.env.ACCOUNT_KIT_ADMISSION_DOMAINS
const DOMAINS_ONLY = 'Runs only with ACCOUNT_KIT_ADMISSION_DOMAINS=example.test'

function as(request: ApiRequest, credential: Credential): ApiRequest {
  if (credential.bearer) request.bearerToken(credential.bearer)
  if (credential.cookie) request.header('cookie', credential.cookie)
  if (credential.csrf) request.header('x-csrf-token', credential.csrf)
  return request
}

/** A CSRF token for the session in `cookie`, or a new session when `cookie` is empty. */
async function csrf(client: ApiClient, cookie = ''): Promise<Credential> {
  const response = await client.get('/api/v1/auth/csrf').header('cookie', cookie)
  return {
    cookie: cookie || cookies(response),
    csrf: (response.body() as { csrfToken: string }).csrfToken,
  }
}

async function anonymous(client: ApiClient): Promise<Credential> {
  return isSessionStrategy ? csrf(client) : {}
}

async function signIn(client: ApiClient, email: string): Promise<Credential> {
  const login = await as(client.post('/api/v1/auth/login'), await anonymous(client)).json({
    email,
    password,
  })
  if (login.status() !== 200) throw new Error(`Login failed: ${JSON.stringify(login.body())}`)
  if (isSessionStrategy) return csrf(client, cookies(login))
  return { bearer: (login.body() as { data: { token: string } }).data.token }
}

async function createPerson(email = `person-${randomUUID()}@example.test`) {
  return User.create({
    fullName: 'Admission Person',
    email,
    password,
    emailVerifiedAt: DateTime.utc(),
  })
}

/** An admitted owner, signed in. */
async function createOwner(client: ApiClient) {
  const owner = await createPerson(`owner-${randomUUID()}@example.test`)
  await grantAdmittedOwner(owner)
  return { owner, credential: await signIn(client, owner.email) }
}

const decisionOf = (response: ApiResponse) => response.body() as Decision
const refusal = (response: ApiResponse) =>
  response.body() as { errors: Array<{ code: string }>; decision: Decision }

/** The owner invites `email` and returns the invitation link path. */
async function invite(client: ApiClient, owner: Credential, email: string) {
  const sent = await as(client.post('/api/v1/account/invitations'), owner).json({
    email,
    role: 'member',
  })
  if (sent.status() !== 201) throw new Error(`Invite failed: ${JSON.stringify(sent.body())}`)
  const notice = notifications.events.find(
    (event) => event.kind === 'invitation' && event.recipient === email
  )
  return `/api/v1/auth/invitations/${encodeURIComponent(tokenFrom(notice!.value))}`
}

async function acceptInvitation(client: ApiClient, path: string) {
  return as(client.post(path), await anonymous(client)).json({
    password,
    passwordConfirmation: password,
    fullName: 'Invited Person',
  })
}

/** Registers `email` through the fixture provider, as a first sign-in, and returns its credential. */
async function socialSignIn(client: ApiClient, email: string): Promise<Credential> {
  const profile = { subject: randomUUID(), email, emailVerified: true }
  if (isSessionStrategy) {
    const start = await csrf(client)
    const started = await as(client.post('/api/v1/auth/oauth/google/redirect'), start).json({
      intent: 'login',
    })
    const state = new URL(
      (started.body() as { authorizationUrl: string }).authorizationUrl
    ).searchParams.get('state')!
    setSocialFixture(state, 'google', 'admission-code', profile)
    const session = cookies(started) || start.cookie!
    const callback = await client
      .get(
        `/api/v1/auth/oauth/google/callback?state=${encodeURIComponent(state)}&code=admission-code`
      )
      .header('cookie', session)
    const continuation = (callback.body() as { continuation: string }).continuation
    const completion = await csrf(client, cookies(callback) || session)
    const completed = await as(client.post('/api/v1/auth/oauth/registration'), completion).json({
      continuation,
      fullName: 'Social Person',
    })
    if (completed.status() !== 200) throw new Error(JSON.stringify(completed.body()))
    return csrf(client, cookies(completed))
  }
  const held = verifier()
  const started = await client.post('/api/v1/auth/oauth/google/redirect').json({
    intent: 'login',
    clientChallenge: challenge(held),
  })
  const state = new URL(
    (started.body() as { authorizationUrl: string }).authorizationUrl
  ).searchParams.get('state')!
  setSocialFixture(state, 'google', 'admission-code', profile)
  const callback = await client
    .post('/api/v1/auth/oauth/google/callback')
    .json({ state, code: 'admission-code', intent: 'login' })
  const completed = await client.post('/api/v1/auth/oauth/registration').json({
    continuation: (callback.body() as { continuation: string }).continuation,
    fullName: 'Social Person',
  })
  const redeemed = await client.post('/api/v1/auth/oauth/token').json({
    code: (completed.body() as { handoffCode: string }).handoffCode,
    verifier: held,
  })
  if (redeemed.status() !== 200) throw new Error(JSON.stringify(redeemed.body()))
  return { bearer: (redeemed.body() as { data: { token: string } }).data.token }
}

test.group('Admission', (group) => {
  group.each.setup(truncateDatabase)
  group.each.setup(() => notifications.reset())

  test('an invited person is gated until approved, and again after revocation', async ({
    client,
    assert,
  }) => {
    const { credential: owner } = await createOwner(client)
    const email = `invited-${randomUUID()}@example.test`
    assert.equal((await acceptInvitation(client, await invite(client, owner, email))).status(), 201)
    const person = await User.findByOrFail('email', email)
    const session = await signIn(client, email)

    const refused = await as(client.get('/api/v1/reports'), session)
    assert.equal(refused.status(), 403)
    assert.equal(refusal(refused).errors[0].code, 'E_ACCOUNT_KIT_ADMISSION_REQUIRED')
    assert.isFalse(refusal(refused).decision.admitted)
    assert.deepEqual(refusal(refused).decision.requirements.invitation, { met: true })
    assert.deepEqual(refusal(refused).decision.requirements.approval, {
      met: false,
      status: 'pending',
      requested: false,
    })
    const status = await as(client.get('/api/v1/account/admission'), session)
    assert.equal(status.status(), 200)
    assert.isFalse(decisionOf(status).admitted)

    const requested = await as(client.post('/api/v1/account/admission/request'), session)
    assert.equal(requested.status(), 200, JSON.stringify(requested.body()))
    const pending = await as(client.get('/api/v1/account/admissions'), owner).qs({
      status: 'pending',
    })
    assert.equal(pending.status(), 200, JSON.stringify(pending.body()))
    assert.deepEqual(
      (pending.body() as { items: Array<{ email: string }> }).items.map((item) => item.email),
      [email]
    )

    const approved = await as(client.post(`/api/v1/account/admissions/${person.id}/approve`), owner)
    assert.equal(approved.status(), 200, JSON.stringify(approved.body()))
    assert.equal((await as(client.get('/api/v1/reports'), session)).status(), 200)

    const revoked = await as(client.post(`/api/v1/account/admissions/${person.id}/revoke`), owner)
    assert.equal(revoked.status(), 200, JSON.stringify(revoked.body()))
    const afterRevoke = await as(client.get('/api/v1/reports'), session)
    assert.equal(afterRevoke.status(), 403)
    assert.equal(refusal(afterRevoke).decision.requirements.approval?.status, 'revoked')

    const again = await signIn(client, email)
    assert.equal((await as(client.get('/api/v1/reports'), again)).status(), 403)
  })

  test('only an admitted owner lists and decides, and never for themselves', async ({
    client,
    assert,
  }) => {
    const { owner, credential } = await createOwner(client)
    const person = await createPerson()
    const pendingOwner = await createPerson()
    await db.table('role_assignments').insert({ user_id: pendingOwner.id, role: 'owner' })
    const pendingSession = await signIn(client, pendingOwner.email)

    const list = await as(client.get('/api/v1/account/admissions'), pendingSession)
    assert.equal(list.status(), 403)
    assert.equal(refusal(list).errors[0].code, 'E_ACCOUNT_KIT_ADMISSION_REQUIRED')
    const approve = as(
      client.post(`/api/v1/account/admissions/${person.id}/approve`),
      pendingSession
    )
    assert.equal((await approve).status(), 403)
    const self = as(client.post(`/api/v1/account/admissions/${owner.id}/approve`), credential)
    assert.equal((await self).status(), 403)
    const member = await createPerson()
    await grantAdmission(member)
    const memberSession = await signIn(client, member.email)
    assert.equal((await as(client.get('/api/v1/reports'), memberSession)).status(), 200)
    const byMember = as(
      client.post(`/api/v1/account/admissions/${person.id}/approve`),
      memberSession
    )
    assert.equal((await byMember).status(), 403)
    assert.equal((await as(client.get('/api/v1/account/admissions'), memberSession)).status(), 403)
    const row = await db.from('account_admissions').where('user_id', person.id).first()
    assert.isNull(row ?? null)
  })

  test('a rejected person sees the decision and stays out', async ({ client, assert }) => {
    const { credential: owner } = await createOwner(client)
    const person = await createPerson()
    const session = await signIn(client, person.email)
    const rejected = await as(client.post(`/api/v1/account/admissions/${person.id}/reject`), owner)
    assert.equal(rejected.status(), 200, JSON.stringify(rejected.body()))

    const status = await as(client.get('/api/v1/account/admission'), session)
    assert.equal(status.status(), 200)
    assert.equal(decisionOf(status).requirements.approval?.status, 'rejected')
    assert.equal((await as(client.get('/api/v1/reports'), session)).status(), 403)
  })

  test('a revoked owner cannot send an invitation', async ({ client, assert }) => {
    const { credential: owner } = await createOwner(client)
    const { owner: other, credential: otherSession } = await createOwner(client)
    const revoked = await as(client.post(`/api/v1/account/admissions/${other.id}/revoke`), owner)
    assert.equal(revoked.status(), 200, JSON.stringify(revoked.body()))

    const sent = await as(client.post('/api/v1/account/invitations'), otherSession).json({
      email: `refused-${randomUUID()}@example.test`,
      role: 'member',
    })
    assert.equal(sent.status(), 403)
    assert.lengthOf(await db.from('account_invitations'), 0)
  })

  test('an invited address that first signs in through a provider meets the invitation', async ({
    client,
    assert,
  }) => {
    const { credential: owner } = await createOwner(client)
    const email = `social-${randomUUID()}@example.test`
    const link = await invite(client, owner, email)
    const session = await socialSignIn(client, email)

    const status = await as(client.get('/api/v1/account/admission'), session)
    assert.equal(status.status(), 200, JSON.stringify(status.body()))
    assert.deepEqual(decisionOf(status).requirements.invitation, { met: true })
    assert.equal(decisionOf(status).requirements.approval?.status, 'pending')
    const invitations = await as(client.get('/api/v1/account/invitations'), owner).qs({ limit: 10 })
    assert.equal(invitations.status(), 200)
    assert.lengthOf((invitations.body() as { items: unknown[] }).items, 0)
    assert.notEqual((await acceptInvitation(client, link)).status(), 201)
  })

  test('an approved and invited person outside the allowed domains stays out', async ({
    client,
    assert,
  }) => {
    const inside = await createPerson()
    const outside = await createPerson(`person-${randomUUID()}@outside.test`)
    await grantAdmission(inside)
    await grantAdmission(outside)

    const allowed = await as(client.get('/api/v1/reports'), await signIn(client, inside.email))
    assert.equal(allowed.status(), 200)
    const refused = await as(client.get('/api/v1/reports'), await signIn(client, outside.email))
    assert.equal(refused.status(), 403)
    assert.deepEqual(refusal(refused).decision.requirements.domain, {
      met: false,
      reason: 'not_allowed',
    })
  }).skip(domains !== 'example.test', DOMAINS_ONLY)
})
