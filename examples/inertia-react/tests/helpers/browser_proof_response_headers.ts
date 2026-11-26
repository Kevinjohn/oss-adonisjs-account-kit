/* eslint-disable @unicorn/no-await-expression-member -- Keep raw response assertions beside their requests. */
import User from '#models/user'
import { Session } from '@adonisjs/session'
import type { Assert } from '@japa/assert'
import { appendFileSync } from 'node:fs'
import { createProofFor } from '../helpers/account_proof.js'

export const origin = process.env.APP_URL!
export const password = 'CorrectedPassword123!'
export const families = ['reset-password', 'verify-email', 'confirm-email'] as const
export type Family = (typeof families)[number]

/** Real HTTP session: manual redirects expose the original token-bearing response. */
export class ProofSession {
  private cookies = new Map<string, string>()
  private version?: string

  constructor(private inertia: boolean) {}

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
    if (this.inertia) {
      headers.set('x-inertia', 'true')
      if (this.version) headers.set('x-inertia-version', this.version)
    }
    if (post) {
      headers.set(
        'content-type',
        options.malformed ? 'application/json' : 'application/x-www-form-urlencoded'
      )
      if (options.csrf !== false) {
        headers.set('x-xsrf-token', decodeURIComponent(this.cookies.get('XSRF-TOKEN') ?? ''))
      }
    }
    if (options.referer) headers.set('referer', options.referer)
    const response = await fetch(new URL(path, origin), {
      method: post ? 'POST' : 'GET',
      headers,
      body: options.malformed
        ? '{"broken":'
        : options.form
          ? new URLSearchParams(options.form)
          : undefined,
      redirect: 'manual',
    })
    for (const cookie of response.headers.getSetCookie()) {
      const [name, value] = cookie.split(';')[0].split('=', 2)
      this.cookies.set(name, value ?? '')
    }
    if (process.env.PROOF_HEADER_EVIDENCE) {
      appendFileSync(
        process.env.PROOF_HEADER_EVIDENCE,
        JSON.stringify({
          method: post ? 'POST' : 'GET',
          path,
          inertia: this.inertia,
          status: response.status,
          headers: Object.fromEntries(
            ['cache-control', 'referrer-policy', 'location', 'content-type'].map((name) => [
              name,
              response.headers.get(name),
            ])
          ),
        }) + '\n'
      )
    }
    return response
  }

  async prime() {
    const response = await this.request('/')
    if (this.inertia) this.version = ((await response.json()) as { version: string }).version
  }
}

export async function proofFor(family: Family, expired = false) {
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
  return createProofFor(user, family, expired)
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
  assert.include([302, 303], response.status)
  const location = response.headers.get('location')!
  assert.equal(new URL(location, origin).origin, origin)
  assert.equal(new URL(location, origin).pathname, expected)
  assert.equal(new URL(location, origin).search, '')
  const followed = await session.request(expected)
  assert.equal(followed.status, 200)
  if (/^\/(reset-password|verify-email|confirm-email)\//.test(expected))
    protectedResponse(assert, followed)
  return followed
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
