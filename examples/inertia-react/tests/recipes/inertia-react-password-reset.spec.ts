/* eslint-disable @unicorn/no-await-expression-member, @unicorn/filename-case -- Keep browser assertions beside requests and match the recipe selector. */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import type { Assert } from '@japa/assert'
import { errors as authErrors } from '@adonisjs/auth'
import testUtils from '@adonisjs/core/services/test_utils'
import { test } from '@japa/runner'
import type { BasePage } from '@japa/browser-client'
import { MessageBuilder } from '@adonisjs/core/helpers'
import db from '@adonisjs/lucid/services/db'
import limiter from '@adonisjs/limiter/services/main'
import { captureNotifications } from '@kevinjohn/adonisjs-account-kit/testing/notifications'
import User from '#models/user'
import { notifyOverrides } from '../../config/account_kit.js'

type Page = BasePage['page']
const oldPassword = 'OriginalPass123!'
const newPassword = 'ReplacementPass123!'
const acknowledgement = 'If an account exists for that address, we have sent a reset link.'

const originalPassword = 'OriginalPass123!'
const replacementPassword = 'ReplacementPass123!'
const recipeOrigin = process.env.APP_URL!

class RecipeProofSession {
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

function assertProofHeaders(
  assert: { equal(actual: unknown, expected: unknown): void },
  response: Response
) {
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer')
}

async function followProtected(
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

const resetForm = { password: replacementPassword, passwordConfirmation: replacementPassword }

async function recipeProof(expired = false) {
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

async function assertUnchanged(assert: Assert, proof: Awaited<ReturnType<typeof recipeProof>>) {
  await proof.owner.refresh()
  assert.equal(proof.owner.password, proof.originalHash)
  assert.equal(
    (await User.verifyCredentials(proof.owner.email, originalPassword)).id,
    proof.owner.id
  )
  assert.exists(await db.from('password_reset_tokens').where('hash', proof.hash).first())
}

/** Verify committed database sessions before following consumes their flash messages. */
async function assertStoredFlash(assert: Assert, feedback: string, secrets: string[]) {
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

async function signIn(page: Page, email: string, password: string) {
  await page.goto('/login')
  await page.getByLabel('Email', { exact: true }).fill(email)
  await page.getByLabel('Password', { exact: true }).fill(password)
  await Promise.all([
    page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/login' && response.request().method() === 'POST'
    ),
    page.getByRole('button', { name: 'Sign in', exact: true }).click(),
  ])
}

async function postProof(page: Page, path: string) {
  // Exercise rejected POSTs even when the invalid-proof page correctly has no password form.
  const csrf = (await page.context().cookies()).find((cookie) => cookie.name === 'XSRF-TOKEN')
  if (!csrf) throw new Error('Missing native Shield CSRF cookie')
  return page.request.post(new URL(path, process.env.APP_URL).href, {
    form: { password: newPassword, passwordConfirmation: newPassword },
    headers: {
      'x-xsrf-token': decodeURIComponent(csrf.value),
    },
    maxRedirects: 0,
  })
}

test('React reset recipe clears failed submissions and revokes both native sessions', async ({
  visit,
  browser,
  assert,
}) => {
  // Restore the migration-owned singleton for direct retained-app reruns.
  await db.table('account_transaction_lock').insert({ id: 1, version: 0 }).onConflict('id').ignore()
  const owner = await User.create({
    fullName: 'Recipe Owner',
    email: `recipe-${randomUUID()}@example.test`,
    password: oldPassword,
  })
  const original = { ...notifyOverrides }
  const capture = captureNotifications()
  Object.assign(notifyOverrides, capture.notify)
  const otherContext = await browser.newContext({ baseURL: process.env.APP_URL })
  const guestContext = await browser.newContext({ baseURL: process.env.APP_URL })
  try {
    const first = await visit('/login')
    const second = await otherContext.visit('/login')
    const guest = await guestContext.visit('/forgot-password')
    for (const page of [first, second]) {
      await signIn(page, owner.email, oldPassword)
      await page.waitForURL('**/dashboard')
      assert.equal((await page.goto('/dashboard'))?.status(), 200)
    }
    const firstCookie = (await first.context().cookies()).find(
      (cookie) => cookie.name === 'adonis-session'
    )
    const secondCookie = (await second.context().cookies()).find(
      (cookie) => cookie.name === 'adonis-session'
    )
    assert.exists(firstCookie)
    assert.exists(secondCookie)
    assert.notEqual(firstCookie!.value, secondCookie!.value)
    await owner.refresh()
    let savedHash = owner.password
    const unchanged = async () => {
      await owner.refresh()
      assert.equal(owner.password, savedHash)
      for (const page of [first, second]) {
        assert.equal((await page.goto('/dashboard'))?.status(), 200)
        assert.equal(new URL(page.url()).pathname, '/dashboard')
      }
    }
    const requestProof = async (email = owner.email) => {
      await limiter.clear(['memory'])
      await guest.goto('/forgot-password')
      await guest.getByLabel('Email', { exact: true }).fill(email)
      await guest.getByRole('button', { name: 'Send reset link' }).click()
      await guest.getByText(acknowledgement, { exact: true }).waitFor()
      return capture.last('passwordResetProvision', owner.email)?.token
    }
    const proof = (await requestProof())!
    assert.isString(proof)
    await requestProof(`missing-${randomUUID()}@example.test`)
    assert.lengthOf(
      capture.messages.filter((message) => message.kind === 'passwordResetProvision'),
      1
    )
    const path = `/reset-password/${encodeURIComponent(proof)}`
    for (let index = 0; index < 2; index++) {
      await guest.goto(path)
      await guest.getByRole('heading', { name: 'Choose a new password' }).waitFor()
    }
    await guest.getByLabel('New password', { exact: true }).fill(newPassword)
    await guest.getByLabel('Confirm new password').fill('DifferentPass123!')
    await guest.getByRole('button', { name: 'Reset password' }).click()
    await guest.getByRole('alert').waitFor()
    assert.equal(await guest.getByLabel('New password', { exact: true }).inputValue(), '')
    assert.equal(await guest.getByLabel('Confirm new password').inputValue(), '')
    await unchanged()

    // Ordinary HTML submissions must not persist either password in session flash.
    const nativeConfirmation = `NativeConfirmation-${randomUUID()}`
    const csrf = (await guest.context().cookies()).find((cookie) => cookie.name === 'XSRF-TOKEN')
    assert.exists(csrf)
    await limiter.clear(['memory'])
    const beforeSessions = new Map(
      (await db.from('sessions').select('id', 'data')).map((row) => [row.id, row.data])
    )
    const nativeFailure = await guest.request.post(new URL(path, process.env.APP_URL).href, {
      form: { password: newPassword, passwordConfirmation: nativeConfirmation },
      headers: {
        'accept': 'text/html',
        'x-xsrf-token': decodeURIComponent(csrf!.value),
      },
      maxRedirects: 0,
    })
    assert.equal(nativeFailure.status(), 302)
    const sessions = await db.from('sessions').select('id', 'data')
    assert.isAtLeast(sessions.length, 2)
    let nativeValidationObserved = false
    for (const row of sessions) {
      const values = new MessageBuilder().verify(row.data, row.id)
      assert.isNotNull(values)
      const persisted = JSON.stringify(values)
      assert.notInclude(persisted, newPassword)
      assert.notInclude(persisted, nativeConfirmation)
      if (beforeSessions.get(row.id) !== row.data && persisted.includes('passwordConfirmation')) {
        nativeValidationObserved = true
      }
    }
    assert.isTrue(nativeValidationObserved)
    await guest.goto(path)
    assert.equal(await guest.getByLabel('New password', { exact: true }).inputValue(), '')
    assert.equal(await guest.getByLabel('Confirm new password').inputValue(), '')
    await unchanged()

    await guest.goto('/reset-password/not-a-proof')
    await guest.getByRole('heading', { name: 'This link can’t be used' }).waitFor()
    assert.equal((await postProof(guest, '/reset-password/not-a-proof')).status(), 302)
    await unchanged()

    await db.from('password_reset_tokens').where('tokenable_id', owner.id).delete()
    const expired = randomBytes(40).toString('base64url')
    await db.table('password_reset_tokens').insert({
      tokenable_id: owner.id,
      email: owner.email,
      hash: createHash('sha256').update(expired).digest('hex'),
      created_at: new Date(Date.now() - 7200000).toISOString(),
      expires_at: new Date(Date.now() - 3600000).toISOString(),
    })
    await guest.goto(`/reset-password/${expired}`)
    await guest.getByRole('heading', { name: 'This link can’t be used' }).waitFor()
    assert.equal((await postProof(guest, `/reset-password/${expired}`)).status(), 302)
    await unchanged()

    const previous = (await requestProof())!
    await guest.goto(`/reset-password/${encodeURIComponent(previous)}`)
    await guest.getByRole('heading', { name: 'Choose a new password' }).waitFor()
    const replacement = (await requestProof())!
    assert.notEqual(replacement, previous)
    await guest.goto(`/reset-password/${encodeURIComponent(previous)}`)
    await guest.getByRole('heading', { name: 'This link can’t be used' }).waitFor()
    assert.equal(
      (await postProof(guest, `/reset-password/${encodeURIComponent(previous)}`)).status(),
      302
    )
    await unchanged()

    const replacementPath = `/reset-password/${encodeURIComponent(replacement)}`
    await guest.goto(replacementPath)
    await guest.getByLabel('New password', { exact: true }).fill(newPassword)
    await guest.getByLabel('Confirm new password').fill(newPassword)
    await guest.getByRole('button', { name: 'Reset password' }).click()
    await guest.waitForURL('**/login')
    for (const page of [first, second]) {
      await page.goto('/dashboard')
      assert.equal(new URL(page.url()).pathname, '/login')
      await page.waitForURL('**/login')
    }
    await signIn(first, owner.email, oldPassword)
    await first.getByText('Invalid email or password.', { exact: true }).waitFor()
    await first.getByRole('heading', { name: 'Welcome back' }).waitFor()
    assert.equal(new URL(first.url()).pathname, '/login')
    // A protected request proves the failed login did not issue a session.
    await first.goto('/dashboard')
    await first.waitForURL('**/login')
    for (const page of [first, second]) {
      await signIn(page, owner.email, newPassword)
      await page.waitForURL('**/dashboard')
    }
    await owner.refresh()
    savedHash = owner.password
    await guest.goto(replacementPath)
    await guest.getByRole('heading', { name: 'This link can’t be used' }).waitFor()
    assert.equal((await postProof(guest, replacementPath)).status(), 302)
    await unchanged()

    // The starter also establishes a session after native signup; keep that route working, including
    // for an address typed in mixed case.
    const signupEmail = `Signup-${randomUUID()}@Example.test`
    await guest.goto('/signup')
    await guest.getByLabel('Full name').fill('New Recipe Account')
    await guest.getByLabel('Email', { exact: true }).fill(signupEmail)
    await guest.getByLabel('Password', { exact: true }).fill(newPassword)
    await guest.getByLabel('Confirm password').fill(newPassword)
    await guest.getByRole('button', { name: 'Create account' }).click()
    await guest.waitForURL('**/dashboard')
    assert.equal((await guest.goto('/dashboard'))?.status(), 200)
    assert.equal(
      (await User.findByOrFail('email', signupEmail.toLowerCase())).fullName,
      'New Recipe Account'
    )
  } finally {
    Object.assign(notifyOverrides, original)
    await otherContext.close()
    await guestContext.close()
  }
})

test.group('React reset recipe response boundaries', (group) => {
  group.each.setup(async () => {
    const cleanup = await testUtils.db().truncate()
    await db
      .table('account_transaction_lock')
      .insert({ id: 1, version: 0 })
      .onConflict('id')
      .ignore()
    return cleanup
  })

  for (const inertia of [false, true]) {
    const representation = inertia ? 'Inertia' : 'HTML'

    test(`${representation}: reset success and consumed GET/POST protect original responses`, async ({
      assert,
    }) => {
      const proof = await recipeProof()
      const session = new RecipeProofSession(inertia)
      await session.prime()
      const read = await session.request(proof.path)
      assertProofHeaders(assert, read)
      assert.equal(read.status, 200)
      assert.include(await read.text(), '"valid":true')
      const complete = await session.request(
        `${proof.path}?token=${proof.token}&sentinel=completion`,
        {
          form: resetForm,
        }
      )
      assertProofHeaders(assert, complete)
      const login = await followProtected(assert, session, complete, '/login')
      const body = await login.text()
      assert.notInclude(body, proof.token)
      assert.notInclude(body, replacementPassword)
      assert.equal(
        (await User.verifyCredentials(proof.owner.email, replacementPassword)).id,
        proof.owner.id
      )
      assert.notExists(await db.from('password_reset_tokens').where('hash', proof.hash).first())
      const replacementHash = (await proof.owner.refresh()).password
      const consumed = await session.request(proof.path)
      assert.equal(consumed.status, 200)
      assertProofHeaders(assert, consumed)
      assert.include(await consumed.text(), '"valid":false')
      const replay = await session.request(`${proof.path}?token=${proof.token}`, {
        form: resetForm,
      })
      assertProofHeaders(assert, replay)
      const renewal = await followProtected(assert, session, replay, '/forgot-password')
      assert.include(await renewal.text(), 'This link is invalid or has expired.')
      assert.equal((await proof.owner.refresh()).password, replacementHash)
      assert.notExists(await db.from('password_reset_tokens').where('hash', proof.hash).first())
      assert.equal(
        (await User.verifyCredentials(proof.owner.email, replacementPassword)).id,
        proof.owner.id
      )
    })

    for (const expired of [false, true]) {
      test(`${representation}: ${expired ? 'expired' : 'malformed'} proof GET/POST and fixed renewal`, async ({
        assert,
      }) => {
        const proof = await recipeProof(expired)
        const path = expired ? proof.path : '/reset-password/not-a-proof'
        const session = new RecipeProofSession(inertia)
        await session.prime()
        const read = await session.request(path)
        assert.equal(read.status, 200)
        assertProofHeaders(assert, read)
        assert.include(await read.text(), '"valid":false')
        const rejected = await session.request(`${path}?token=${proof.token}&sentinel=invalid`, {
          form: resetForm,
          referer: 'https://untrusted.example/steal',
        })
        assertProofHeaders(assert, rejected)
        await assertStoredFlash(assert, 'This link is invalid or has expired.', [
          proof.token,
          replacementPassword,
        ])
        const renewal = await followProtected(assert, session, rejected, '/forgot-password')
        assert.include(await renewal.text(), 'This link is invalid or has expired.')
        await assertUnchanged(assert, proof)
      })
    }

    for (const expired of [false, true]) {
      test(`${representation}: ${expired ? 'expired' : 'unestablished'} proof validation uses fixed renewal`, async ({
        assert,
      }) => {
        const proof = await recipeProof(expired)
        const session = new RecipeProofSession(inertia)
        await session.prime()
        const path = expired ? proof.path : '/reset-password/not-a-proof'
        const rejected = await session.request(`${path}?token=${proof.token}&sentinel=validation`, {
          form: { ...resetForm, passwordConfirmation: 'MismatchedSecret123!' },
          referer: 'https://untrusted.example/steal',
        })
        assertProofHeaders(assert, rejected)
        await assertStoredFlash(assert, 'This link is invalid or has expired.', [
          proof.token,
          replacementPassword,
          'MismatchedSecret123!',
        ])
        const renewal = await followProtected(assert, session, rejected, '/forgot-password')
        const feedback = await renewal.text()
        assert.include(feedback, 'This link is invalid or has expired.')
        assert.notInclude(feedback, proof.token)
        assert.notInclude(feedback, replacementPassword)
        assert.notInclude(feedback, 'MismatchedSecret123!')
        await assertUnchanged(assert, proof)
      })
    }

    test(`${representation}: malformed JSON fails before CSRF and allows protected retry`, async ({
      assert,
    }) => {
      const proof = await recipeProof()
      const session = new RecipeProofSession(inertia)
      await session.prime()
      const malformed = await session.request(`${proof.path}?token=${proof.token}`, {
        malformed: true,
        csrf: false,
      })
      assert.equal(malformed.status, 400)
      assertProofHeaders(assert, malformed)
      assert.isNull(malformed.headers.get('location'))
      // Malformed JSON is sent without CSRF: a parser rejection must win over CSRF recovery.
      const retried = await session.request(proof.path)
      assert.equal(retried.status, 200)
      assertProofHeaders(assert, retried)
      assert.include(await retried.text(), '"valid":true')
      await assertUnchanged(assert, proof)
    })

    test(`${representation}: unestablished proof CSRF uses fixed renewal and safe committed flash`, async ({
      assert,
    }) => {
      const session = new RecipeProofSession(inertia)
      await session.prime()
      const rejected = await session.request('/reset-password/not-a-proof?token=injected-bearer', {
        form: {
          ...resetForm,
          email: 'injected@example.test',
          token: 'injected-bearer',
          extra: 'injected-extra',
        },
        csrf: false,
        referer: 'https://untrusted.example/steal',
      })
      assertProofHeaders(assert, rejected)
      await assertStoredFlash(assert, 'The form expired.', [
        replacementPassword,
        'injected@example.test',
        'injected-bearer',
        'injected-extra',
      ])
      const renewal = await followProtected(assert, session, rejected, '/forgot-password')
      assert.include(await renewal.text(), 'The form expired.')
    })

    for (const referer of [undefined, 'https://untrusted.example/steal']) {
      for (const csrf of [false, true]) {
        test(`${representation}: ${csrf ? 'validation' : 'CSRF'} correction with ${referer ? 'hostile' : 'absent'} Referer`, async ({
          assert,
        }) => {
          const proof = await recipeProof()
          const session = new RecipeProofSession(inertia)
          await session.prime()
          const confirmation = csrf ? 'MismatchedSecret123!' : replacementPassword
          const rejected = await session.request(
            `${proof.path}?token=${proof.token}&sentinel=recovery`,
            {
              form: {
                password: replacementPassword,
                passwordConfirmation: confirmation,
                email: 'injected@example.test',
                token: proof.token,
                extra: 'injected-extra',
              },
              csrf,
              referer,
            }
          )
          assertProofHeaders(assert, rejected)
          await assertStoredFlash(assert, csrf ? 'passwordConfirmation' : 'The form expired.', [
            replacementPassword,
            confirmation,
            proof.token,
            'injected@example.test',
            'injected-extra',
          ])
          const recovered = await followProtected(assert, session, rejected, proof.path)
          const feedback = await recovered.text()
          assert.include(feedback, csrf ? 'passwordConfirmation' : 'The form expired.')
          assert.notInclude(feedback, replacementPassword)
          assert.notInclude(feedback, confirmation)
          await assertUnchanged(assert, proof)
          // The followed form supplies the real session's fresh XSRF cookie.
          const corrected = await session.request(
            `${proof.path}?token=${proof.token}&sentinel=corrected`,
            { form: resetForm }
          )
          assertProofHeaders(assert, corrected)
          const login = await followProtected(assert, session, corrected, '/login')
          const body = await login.text()
          assert.notInclude(body, proof.token)
          assert.notInclude(body, replacementPassword)
          assert.notExists(await db.from('password_reset_tokens').where('hash', proof.hash).first())
          assert.equal(
            (await User.verifyCredentials(proof.owner.email, replacementPassword)).id,
            proof.owner.id
          )
          await assert.rejects(
            () => User.verifyCredentials(proof.owner.email, originalPassword),
            authErrors.E_INVALID_CREDENTIALS
          )
        })
      }
    }
  }

  test('an expired proof validation failure visibly explains renewal in the browser', async ({
    visit,
    assert,
  }) => {
    const proof = await recipeProof()
    const page = await visit(`${proof.path}?token=${proof.token}&sentinel=browser-validation`)
    await page.getByLabel('New password', { exact: true }).fill(replacementPassword)
    await page.getByLabel('Confirm new password').fill('MismatchedSecret123!')
    // Expire after rendering so the real mounted form submits a now-unusable proof.
    await db
      .from('password_reset_tokens')
      .where('hash', proof.hash)
      .update({ expires_at: new Date(Date.now() - 3600000).toISOString() })
    const [rejected] = await Promise.all([
      page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === proof.path && response.request().method() === 'POST'
      ),
      page.getByRole('button', { name: 'Reset password', exact: true }).click(),
    ])
    assert.include([302, 303], rejected.status())
    assert.equal(rejected.headers()['cache-control'], 'no-store')
    assert.equal(rejected.headers()['referrer-policy'], 'no-referrer')
    const destination = new URL(rejected.headers()['location'], recipeOrigin)
    assert.equal(destination.origin, recipeOrigin)
    assert.equal(destination.pathname, '/forgot-password')
    assert.equal(destination.search, '')
    await page.waitForURL('**/forgot-password')
    await page.getByRole('heading', { name: 'Forgot your password?' }).waitFor()
    await page.getByText('This link is invalid or has expired.', { exact: true }).waitFor()
    await assertUnchanged(assert, proof)
  })

  test('the mounted React form clears secrets and completes the corrected proof', async ({
    visit,
    assert,
  }) => {
    const proof = await recipeProof()
    const page = await visit(proof.path)
    await page.getByLabel('New password', { exact: true }).fill(replacementPassword)
    await page.getByLabel('Confirm new password').fill('MismatchedSecret123!')
    await page.getByRole('button', { name: 'Reset password', exact: true }).click()
    await page.getByRole('alert').waitFor()
    assert.equal(await page.getByLabel('New password', { exact: true }).inputValue(), '')
    assert.equal(await page.getByLabel('Confirm new password').inputValue(), '')
    assert.equal(new URL(page.url()).pathname, proof.path)
    await assertUnchanged(assert, proof)
    await page.getByLabel('New password', { exact: true }).fill(replacementPassword)
    await page.getByLabel('Confirm new password').fill(replacementPassword)
    await page.getByRole('button', { name: 'Reset password', exact: true }).click()
    await page.waitForURL('**/login')
    assert.notExists(await db.from('password_reset_tokens').where('hash', proof.hash).first())
    assert.equal(
      (await User.verifyCredentials(proof.owner.email, replacementPassword)).id,
      proof.owner.id
    )
    await assert.rejects(
      () => User.verifyCredentials(proof.owner.email, originalPassword),
      authErrors.E_INVALID_CREDENTIALS
    )
  })

  test('reset page suppresses the actual same-origin browser follow-on Referer', async ({
    visit,
    assert,
  }) => {
    const proof = await recipeProof()
    const page = await visit('/login')
    const response = await page.goto(new URL(proof.path, recipeOrigin).href)
    assert.equal(response!.headers()['cache-control'], 'no-store')
    assert.equal(response!.headers()['referrer-policy'], 'no-referrer')
    const followOn = page.waitForRequest(
      (request) => new URL(request.url()).pathname === '/forgot-password'
    )
    const status = await page.evaluate(async () => (await fetch('/forgot-password')).status)
    assert.equal(status, 200)
    const referrer = (await followOn).headers()['referer'] ?? ''
    assert.equal(referrer, '')
    if (process.env.PROOF_HEADER_EVIDENCE) {
      appendFileSync(
        process.env.PROOF_HEADER_EVIDENCE,
        JSON.stringify({ browser: true, family: 'reset-password', referrer }) + '\n'
      )
    }
    await assertUnchanged(assert, proof)
  })
})
