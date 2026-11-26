/* eslint-disable @unicorn/no-await-expression-member -- Inline awaited requests keep each assertion tied to the HTTP operation it verifies. */

import User from '#models/user'
import { notifications } from '#services/account_kit_notifications'
import {
  pkceChallenge as challenge,
  pkceVerifier as verifier,
} from '#services/social_browser_transaction'
import { grantAdmittedOwner } from '#tests/helpers/admission'
import { cookies } from '#tests/helpers/cookies'
import { tokenFrom } from '#tests/helpers/link_tokens'
import { setSocialFixture } from '#tests/helpers/social_provider_fixture'
import { isSessionStrategy } from '#tests/helpers/strategy'
import type { ApiClient, ApiRequest, ApiResponse } from '@japa/api-client'
import { DateTime } from 'luxon'
import { randomUUID } from 'node:crypto'

/** A signed-in or anonymous caller in either strategy. */
export interface Credential {
  bearer?: string
  cookie?: string
  csrf?: string
}

export interface Decision {
  admitted: boolean
  requirements: {
    domain?: { met: boolean; reason?: string }
    invitation?: { met: boolean }
    approval?: { met: boolean; status: string; requested: boolean }
  }
}

export const password = 'AdmissionPass123!'
export const domains = process.env.ACCOUNT_KIT_ADMISSION_DOMAINS
export const DOMAINS_ONLY = 'Runs only with ACCOUNT_KIT_ADMISSION_DOMAINS=example.test'

export function as(request: ApiRequest, credential: Credential): ApiRequest {
  if (credential.bearer) request.bearerToken(credential.bearer)
  if (credential.cookie) request.header('cookie', credential.cookie)
  if (credential.csrf) request.header('x-csrf-token', credential.csrf)
  return request
}

/** A CSRF token for the session in `cookie`, or a new session when `cookie` is empty. */
export async function csrf(client: ApiClient, cookie = ''): Promise<Credential> {
  const response = await client.get('/api/v1/auth/csrf').header('cookie', cookie)
  return {
    cookie: cookie || cookies(response),
    csrf: (response.body() as { csrfToken: string }).csrfToken,
  }
}

export async function anonymous(client: ApiClient): Promise<Credential> {
  return isSessionStrategy ? csrf(client) : {}
}

export async function signIn(client: ApiClient, email: string): Promise<Credential> {
  const login = await as(client.post('/api/v1/auth/login'), await anonymous(client)).json({
    email,
    password,
  })
  if (login.status() !== 200) throw new Error(`Login failed: ${JSON.stringify(login.body())}`)
  if (isSessionStrategy) return csrf(client, cookies(login))
  return { bearer: (login.body() as { data: { token: string } }).data.token }
}

export async function createPerson(email = `person-${randomUUID()}@example.test`) {
  return User.create({
    fullName: 'Admission Person',
    email,
    password,
    emailVerifiedAt: DateTime.utc(),
  })
}

/** An admitted owner, signed in. */
export async function createOwner(client: ApiClient) {
  const owner = await createPerson(`owner-${randomUUID()}@example.test`)
  await grantAdmittedOwner(owner)
  return { owner, credential: await signIn(client, owner.email) }
}

export const decisionOf = (response: ApiResponse) => response.body() as Decision
export const refusal = (response: ApiResponse) =>
  response.body() as { errors: Array<{ code: string }>; decision: Decision }

/** The owner invites `email` and returns the invitation link path. */
export async function invite(client: ApiClient, owner: Credential, email: string) {
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

export async function acceptInvitation(client: ApiClient, path: string) {
  return as(client.post(path), await anonymous(client)).json({
    password,
    passwordConfirmation: password,
    fullName: 'Invited Person',
  })
}

/** Registers `email` through the fixture provider, as a first sign-in, and returns its credential. */
export async function socialSignIn(client: ApiClient, email: string): Promise<Credential> {
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
