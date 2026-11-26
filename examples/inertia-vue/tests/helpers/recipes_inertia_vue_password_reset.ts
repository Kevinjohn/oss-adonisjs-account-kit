/* eslint-disable @unicorn/no-await-expression-member -- Keep browser assertions beside each native form action. */
import User from '#models/user'
import { MessageBuilder } from '@adonisjs/core/helpers'
import db from '@adonisjs/lucid/services/db'
import type { Assert } from '@japa/assert'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { appendFileSync } from 'node:fs'

export const originalPassword = 'OriginalPass123!'
export const replacementPassword = 'ReplacementPass123!'
export const recipeOrigin = process.env.APP_URL!

export class RecipeProofSession {
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
      if (!options.malformed && options.csrf !== false) {
        headers.set('x-xsrf-token', decodeURIComponent(this.cookies.get('XSRF-TOKEN') ?? ''))
      }
    }
    if (options.referer) headers.set('referer', options.referer)
    const response = await fetch(new URL(path, recipeOrigin), {
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

export function assertProofHeaders(
  assert: { equal(actual: unknown, expected: unknown): void },
  response: Response
) {
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer')
}

export async function followProtected(
  assert: Parameters<typeof assertProofHeaders>[0],
  session: RecipeProofSession,
  response: Response,
  path: string
) {
  assert.equal([302, 303].includes(response.status), true)
  const location = response.headers.get('location')!
  assert.equal(new URL(location, recipeOrigin).origin, recipeOrigin)
  assert.equal(new URL(location, recipeOrigin).pathname, path)
  assert.equal(new URL(location, recipeOrigin).search, '')
  const followed = await session.request(path)
  assert.equal(followed.status, 200)
  if (path.startsWith('/reset-password/')) assertProofHeaders(assert, followed)
  return followed
}

export const resetForm = {
  password: replacementPassword,
  passwordConfirmation: replacementPassword,
}

export async function recipeProof(expired = false) {
  const email = `boundary-${randomUUID()}@example.test`
  const owner = await User.create({
    fullName: 'Recipe Proof Owner',
    email,
    password: originalPassword,
  })
  const token = randomBytes(40).toString('base64url')
  const hash = createHash('sha256').update(token).digest('hex')
  const now = new Date()
  await db.table('password_reset_tokens').insert({
    tokenable_id: owner.id,
    email,
    hash,
    created_at: new Date(now.getTime() - (expired ? 7200000 : 0)).toISOString(),
    expires_at: new Date(now.getTime() + (expired ? -3600000 : 3600000)).toISOString(),
  })
  return { owner, token, hash, path: `/reset-password/${token}`, originalHash: owner.password }
}

export async function assertUnchanged(
  assert: Assert,
  proof: Awaited<ReturnType<typeof recipeProof>>
) {
  await proof.owner.refresh()
  assert.equal(proof.owner.password, proof.originalHash)
  assert.equal(
    (await User.verifyCredentials(proof.owner.email, originalPassword)).id,
    proof.owner.id
  )
  assert.exists(await db.from('password_reset_tokens').where('hash', proof.hash).first())
}

/** Verify committed database sessions before following consumes their flash messages. */
export async function assertStoredFlash(assert: Assert, feedback: string, secrets: string[]) {
  const rows = await db.from('sessions').select('id', 'data')
  assert.isAbove(rows.length, 0)
  const decoded = rows.map((row) => {
    const data = new MessageBuilder().verify(row.data, row.id)
    assert.isNotNull(data)
    return data as { __flash__?: Record<string, unknown> }
  })
  const flashes = decoded.map((data) => data.__flash__).filter(Boolean)
  assert.isAbove(flashes.length, 0)
  const stored = JSON.stringify(flashes)
  assert.include(stored, feedback)
  for (const secret of secrets) assert.notInclude(stored, secret)
  for (const flash of flashes) {
    for (const key of ['password', 'passwordConfirmation', 'email', 'token', 'extra']) {
      assert.notProperty(flash!, key)
    }
  }
}
