/* eslint-disable @unicorn/no-await-expression-member -- Inline responses keep each assertion tied to the HTTP operation it verifies. */

import User from '#models/user'
import db from '@adonisjs/lucid/services/db'
import { createHash, randomBytes } from 'node:crypto'

export const password = 'ReplacementPass123!'
export const replayPassword = 'SecondReplacement123!'
export const origin = process.env.APP_URL!

export class HttpSession {
  private cookies = new Map<string, string>()
  private version: string | undefined

  async request(path: string, form?: Record<string, string>) {
    const headers = new Headers({
      cookie: [...this.cookies].map(([key, value]) => `${key}=${value}`).join('; '),
    })
    headers.set('x-inertia', 'true')
    if (this.version) headers.set('x-inertia-version', this.version)
    if (form) {
      headers.set('content-type', 'application/x-www-form-urlencoded')
      headers.set('x-xsrf-token', decodeURIComponent(this.cookies.get('XSRF-TOKEN') ?? ''))
      headers.set('referer', new URL(path, origin).href)
    }
    const response = await fetch(new URL(path, origin), {
      method: form ? 'POST' : 'GET',
      headers,
      body: form ? new URLSearchParams(form) : undefined,
      redirect: 'manual',
    })
    for (const cookie of response.headers.getSetCookie()) {
      const [name, value] = cookie.split(';')[0].split('=', 2)
      if (name) this.cookies.set(name, value ?? '')
    }
    return response
  }

  async login(user: User) {
    const loginPage = await this.request('/login')
    this.version = ((await loginPage.json()) as { version: string }).version
    const response = await this.request('/login', { email: user.email, password: 'OldPass123!' })
    // A refused login also answers 302, back to the form; only the dashboard means signed in.
    if (!response.headers.get('location')?.endsWith('/dashboard'))
      throw new Error(`Login for ${user.email} did not sign in`)
    return response
  }
}

export async function proofFor(user: User, expired = false) {
  const token = randomBytes(40).toString('base64url')
  const hash = createHash('sha256').update(token).digest('hex')
  const now = new Date()
  await db.table('password_reset_tokens').insert({
    tokenable_id: user.id,
    email: user.email,
    hash,
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + (expired ? -1000 : 3600000)).toISOString(),
  })
  return { token, hash, path: `/reset-password/${token}` }
}

export async function page(session: HttpSession, path: string) {
  const response = await session.request(path)
  const body = (await response.json()) as { props: { valid: boolean; user?: { id: number } } }
  return { status: response.status, body }
}
