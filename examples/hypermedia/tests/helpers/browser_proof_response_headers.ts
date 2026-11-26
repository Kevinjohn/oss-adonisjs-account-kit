/* eslint-disable @unicorn/no-await-expression-member -- Keep original responses beside their state and destination assertions. */
import User from '#models/user'
import db from '@adonisjs/lucid/services/db'
import { Session } from '@adonisjs/session'
import type { Assert } from '@japa/assert'
import { createHash, randomBytes } from 'node:crypto'
import { appendFileSync } from 'node:fs'

export const origin = process.env.APP_URL!
export const password = 'CorrectedPassword123!'
export const families = ['reset-password', 'verify-email', 'confirm-email'] as const
export type Family = (typeof families)[number]
export const csrfMessage = 'Invalid or expired CSRF token'

/** Real native form session with manual redirects and the server-rendered hidden CSRF token. */
export class ProofSession {
  private cookies = new Map<string, string>()
  private csrf?: string

  async request(
    path: string,
    options: {
      form?: Record<string, string>
      malformed?: boolean
      csrf?: boolean
      referer?: string
    } = {}
  ) {
    const post = options.form !== undefined || options.malformed
    const headers = new Headers({
      accept: 'text/html',
      cookie: [...this.cookies].map(([key, value]) => `${key}=${value}`).join('; '),
    })
    if (post)
      headers.set(
        'content-type',
        options.malformed ? 'application/json' : 'application/x-www-form-urlencoded'
      )
    if (options.referer) headers.set('referer', options.referer)
    const response = await fetch(new URL(path, origin), {
      method: post ? 'POST' : 'GET',
      headers,
      body: options.malformed
        ? '{"broken":'
        : options.form
          ? new URLSearchParams({
              ...options.form,
              ...(options.csrf === false ? {} : { _csrf: this.csrf ?? '' }),
            })
          : undefined,
      redirect: 'manual',
    })
    for (const cookie of response.headers.getSetCookie()) {
      const [name, value] = cookie.split(';')[0].split('=', 2)
      this.cookies.set(name, value ?? '')
    }
    if (response.headers.get('content-type')?.includes('text/html')) {
      const html = await response.clone().text()
      const input = html.match(/<input\b[^>]*\bname=(["'])_csrf\1[^>]*>/)?.[0]
      const token = input?.match(/\bvalue=(["'])([^"']+)\1/)?.[2]
      if (token) this.csrf = token
    }
    if (process.env.PROOF_HEADER_EVIDENCE)
      appendFileSync(
        process.env.PROOF_HEADER_EVIDENCE,
        JSON.stringify({
          method: post ? 'POST' : 'GET',
          path,
          status: response.status,
          headers: Object.fromEntries(
            ['cache-control', 'referrer-policy', 'location', 'content-type'].map((name) => [
              name,
              response.headers.get(name),
            ])
          ),
        }) + '\n'
      )
    return response
  }

  async prime() {
    await this.request('/login')
    if (!this.csrf) throw new Error('The native login form did not render a CSRF token')
  }
}

export async function proofFor(family: Family, expired = false) {
  const token = randomBytes(40).toString('base64url')
  const email = `${family}@example.test`
  const user = await User.create({
    fullName: 'Proof Owner',
    email,
    password: 'OldPass123!',
    unverifiedEmail:
      family === 'verify-email'
        ? email
        : family === 'confirm-email'
          ? 'changed@example.test'
          : null,
  })
  const hash = createHash('sha256').update(token).digest('hex')
  const table = family === 'reset-password' ? 'password_reset_tokens' : 'email_verification_tokens'
  const now = new Date()
  await db.table(table).insert({
    tokenable_id: user.id,
    email: family === 'confirm-email' ? 'changed@example.test' : email,
    ...(family === 'reset-password'
      ? {}
      : {
          current_email: email,
          purpose: family === 'confirm-email' ? 'email_change' : 'activation',
        }),
    hash,
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + (expired ? -1000 : 3600000)).toISOString(),
  })
  return { user, token, hash, table, path: `/${family}/${token}` }
}

export function protectedResponse(assert: Assert, response: Response) {
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer')
}

export async function destination(
  assert: Assert,
  session: ProofSession,
  response: Response,
  expected: string
) {
  assert.equal(response.status, 302)
  const location = new URL(response.headers.get('location')!, origin)
  assert.equal(location.origin, origin)
  assert.equal(location.pathname, expected)
  assert.equal(location.search, '')
  const followed = await session.request(expected)
  assert.equal(followed.status, 200)
  if (/^\/(reset-password|verify-email|confirm-email)\//.test(expected))
    protectedResponse(assert, followed)
  return followed
}

export async function completed(
  assert: Assert,
  family: Family,
  proof: Awaited<ReturnType<typeof proofFor>>
) {
  assert.notExists(await db.from(proof.table).where('hash', proof.hash).first())
  if (family === 'confirm-email')
    assert.equal((await User.findOrFail(proof.user.id)).email, 'changed@example.test')
  else assert.equal((await User.verifyCredentials(proof.user.email, password)).id, proof.user.id)
}

/** Observe the data real session middleware commits; restore even when a request fails. */
export async function capturedFlashes<T>(operation: () => Promise<T>) {
  const committing = Session.prototype as unknown as { commit: (this: Session) => Promise<void> }
  const previous = committing.commit
  const flashes: string[] = []
  committing.commit = async function () {
    const feedback = JSON.stringify(this.responseFlashMessages.all())
    await previous.call(this)
    flashes.push(feedback)
  }
  try {
    return { result: await operation(), flashes }
  } finally {
    committing.commit = previous
  }
}

export function safeCapturedFeedback(
  assert: Assert,
  flashes: string[],
  expected: string,
  secrets: string[]
) {
  assert.isNotEmpty(flashes)
  const persisted = flashes.join()
  assert.include(persisted, expected)
  assert.notInclude(persisted, '"input"')
  for (const secret of secrets) assert.notInclude(persisted, secret)
}

export const form = { password, passwordConfirmation: password }
