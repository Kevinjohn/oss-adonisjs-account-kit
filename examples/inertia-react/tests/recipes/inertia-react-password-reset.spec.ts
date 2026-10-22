/* eslint-disable @unicorn/no-await-expression-member, @unicorn/filename-case -- Keep browser assertions beside requests and match the recipe selector. */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { test } from '@japa/runner'
import type { BasePage } from '@japa/browser-client'
import app from '@adonisjs/core/services/app'
import db from '@adonisjs/lucid/services/db'
import limiter from '@adonisjs/limiter/services/main'
import { captureNotifications } from 'adonisjs-account-kit/testing/notifications'
import type { ResolvedConfig } from 'adonisjs-account-kit/types'
import User from '#models/user'

type Page = BasePage['page']
const oldPassword = 'OriginalPass123!'
const newPassword = 'ReplacementPass123!'
const acknowledgement = 'If an account exists for that address, we have sent a reset link.'

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
      'referer': new URL(path, process.env.APP_URL).href,
    },
    maxRedirects: 0,
  })
}

test('React reset recipe preserves failed submissions and revokes both native sessions', async ({
  visit,
  browser,
  assert,
}) => {
  const owner = await User.create({
    fullName: 'Recipe Owner',
    email: `recipe-${randomUUID()}@example.test`,
    password: oldPassword,
  })
  const config = app.config.get<ResolvedConfig>('account_kit')
  const original = { ...config.notify }
  const capture = captureNotifications()
  Object.assign(config.notify, capture.notify)
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
    assert.equal(await guest.getByLabel('New password', { exact: true }).inputValue(), newPassword)
    assert.equal(await guest.getByLabel('Confirm new password').inputValue(), 'DifferentPass123!')
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
      await page.waitForURL('**/login')
      assert.equal(new URL(page.url()).pathname, '/login')
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

    // The starter also establishes a session after native signup; keep that route working.
    await guest.goto('/signup')
    await guest.getByLabel('Full name').fill('New Recipe Account')
    await guest.getByLabel('Email', { exact: true }).fill(`signup-${randomUUID()}@example.test`)
    await guest.getByLabel('Password', { exact: true }).fill(newPassword)
    await guest.getByLabel('Confirm password').fill(newPassword)
    await guest.getByRole('button', { name: 'Create account' }).click()
    await guest.waitForURL('**/dashboard')
    assert.equal((await guest.goto('/dashboard'))?.status(), 200)
  } finally {
    Object.assign(config.notify, original)
    await otherContext.close()
    await guestContext.close()
  }
})
