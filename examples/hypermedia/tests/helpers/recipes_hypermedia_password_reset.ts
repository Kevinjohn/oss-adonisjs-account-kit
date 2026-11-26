/* eslint-disable @unicorn/no-await-expression-member -- Keep response assertions beside the requests they verify. */
import User from '#models/user'
import { accountKitNotifications } from '#services/account_kit_notifications'
import { MessageBuilder } from '@adonisjs/core/helpers'
import db from '@adonisjs/lucid/services/db'
import type { Assert } from '@japa/assert'
import { createHash, randomBytes } from 'node:crypto'

export const origin = process.env.APP_URL!

/** The path and search of the latest reset link the package sent, after checking its origin and route. */
export function emailedResetPath(assert: Assert, email: string) {
  const message = accountKitNotifications.last('passwordResetProvision', email)
  assert.exists(message?.actionUrl, `no password reset link was sent to ${email}`)
  const url = new URL(message!.actionUrl!)
  assert.equal(url.origin, new URL(origin).origin)
  assert.equal(url.pathname, `/reset-password/${encodeURIComponent(message!.token!)}`)
  return `${url.pathname}${url.search}`
}

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
    return response
  }

  async prime() {
    await this.request('/login')
    if (!this.csrf) throw new Error('The native login form did not render a CSRF token')
  }
}

export async function recipeProof(expired = false) {
  const token = randomBytes(40).toString('base64url')
  const owner = await User.create({
    fullName: 'Boundary Owner',
    email: 'boundary@example.test',
    password: 'OriginalPass123!',
  })
  const hash = createHash('sha256').update(token).digest('hex')
  const now = new Date()
  await db.table('password_reset_tokens').insert({
    tokenable_id: owner.id,
    email: owner.email,
    hash,
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + (expired ? -1000 : 3600000)).toISOString(),
  })
  return { owner, token, hash, path: `/reset-password/${token}` }
}

export function protectedResponse(assert: Assert, response: Response) {
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer')
}

export async function destination(
  assert: Assert,
  session: ProofSession,
  response: Response,
  path: string
) {
  assert.equal(response.status, 302)
  const location = new URL(response.headers.get('location')!, origin)
  assert.equal(location.origin, origin)
  assert.equal(location.pathname, path)
  assert.equal(location.search, '')
  const followed = await session.request(path)
  assert.equal(followed.status, 200)
  if (path.startsWith('/reset-password/')) protectedResponse(assert, followed)
  return followed
}

/** Read the real database session after the request commits and before following consumes flash. */
export async function storedFeedback(assert: Assert, expected: string, secrets: string[]) {
  const rows = await db.from('sessions').select('id', 'data')
  assert.isNotEmpty(rows)
  const flashes = rows
    .map((row) => {
      const data = new MessageBuilder().verify(row.data, row.id)
      assert.isNotNull(data)
      return (data as { __flash__?: Record<string, unknown> }).__flash__
    })
    .filter(Boolean)
  assert.isNotEmpty(flashes)
  const stored = JSON.stringify(flashes)
  assert.include(stored, expected)
  assert.notInclude(stored, '"input"')
  for (const secret of secrets) assert.notInclude(stored, secret)
}

export const resetForm = {
  password: 'CorrectedPass123!',
  passwordConfirmation: 'CorrectedPass123!',
}
export const csrfMessage = 'Invalid or expired CSRF token'
